import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { OwnershipService } from '../auth/authorization/ownership.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  buildPaginationMeta,
  type PaginatedResult,
  toPageOffset,
} from '../common/utils/public-search.util';
import { assertProviderCanRespondToReviews } from '../providers/provider-lifecycle.policy';
import type { Provider } from '../providers/entities/provider.entity';
import type {
  ProviderReviewRespondedFilter,
  ProviderReviewSort,
  ProviderReviewVisibilityFilter,
} from './dto/provider-review-list-query.dto';
import {
  PROVIDER_REVIEW_COLUMNS,
  PROVIDER_REVIEW_FROM,
  type ProviderReviewRow,
  type ProviderReviewView,
  toProviderReviewView,
} from './provider-review-views';

export const REVIEW_NOT_FOUND = 'Review not found';
export const REVIEW_HIDDEN_CONFLICT = 'Hidden reviews cannot be responded to';
export const REVIEW_ALREADY_RESPONDED = 'Review already has a response';

export interface ProviderReviewListQuery {
  page: number;
  limit: number;
  maxId?: string;
  rating?: number;
  visibility: ProviderReviewVisibilityFilter;
  responded: ProviderReviewRespondedFilter;
  sort: ProviderReviewSort;
}

export interface ProviderReviewListEcho {
  rating: number | null;
  visibility: ProviderReviewVisibilityFilter;
  responded: ProviderReviewRespondedFilter;
  sort: ProviderReviewSort;
  maxId: string | null;
}

/** Every ORDER BY ends with r.id, so the order is total and deterministic. */
const ORDER_BY: Record<ProviderReviewSort, string> = {
  newest: 'r.created_at DESC, r.id DESC',
  oldest: 'r.created_at ASC, r.id ASC',
  rating_desc: 'r.rating DESC, r.created_at DESC, r.id DESC',
  rating_asc: 'r.rating ASC, r.created_at DESC, r.id DESC',
};

/**
 * Provider feedback (P3-BE08): the provider-scoped review list and the
 * owner's one-time response.
 *
 * Scope is always derived from the authenticated user (owner: the provider
 * they own; staff: their single ACTIVE `provider_staff` row, `user_id` is
 * UNIQUE so there is never a provider to choose) and applied in SQL on
 * `bookings.provider_id`. No request value contributes to the scope.
 *
 * The public review list, `/reviews/mine`, review creation (P2-14) and the
 * rating aggregates are untouched: they live in ReviewsService/AdminService.
 */
@Injectable()
export class ProviderReviewsService {
  private readonly logger = new Logger(ProviderReviewsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly ownershipService: OwnershipService,
  ) {}

  async list(
    user: AuthenticatedUser,
    query: ProviderReviewListQuery,
  ): Promise<PaginatedResult<ProviderReviewView, ProviderReviewListEcho>> {
    const providerId = await this.ownershipService.getManagedProviderId(user);
    const echo = (maxId: string | null): ProviderReviewListEcho => ({
      rating: query.rating ?? null,
      visibility: query.visibility,
      responded: query.responded,
      sort: query.sort,
      maxId,
    });

    // The anchor is the newest review of THIS provider, so it reveals
    // nothing about other providers' review volume.
    const anchor =
      query.maxId ??
      ((await this.dataSource.query(
        `SELECT max(r.id)::text AS max FROM reviews r JOIN bookings b ON b.id = r.booking_id WHERE b.provider_id = $1`,
        [providerId],
      )) as { max: string | null }[])[0].max;

    if (anchor === null) {
      return { items: [], meta: buildPaginationMeta(query.page, query.limit, 0), query: echo(null) };
    }

    const params: unknown[] = [providerId, anchor];
    const conditions = ['b.provider_id = $1', 'r.id <= $2'];

    if (query.rating !== undefined) {
      params.push(query.rating);
      conditions.push(`r.rating = $${params.length}`);
    }
    if (query.visibility !== 'all') {
      conditions.push(query.visibility === 'visible' ? 'r.is_visible' : 'NOT r.is_visible');
    }
    if (query.responded !== 'all') {
      conditions.push(
        query.responded === 'responded' ? 'r.provider_response IS NOT NULL' : 'r.provider_response IS NULL',
      );
    }

    const where = conditions.join(' AND ');
    const [{ total }] = (await this.dataSource.query(
      `SELECT count(*)::int AS total FROM reviews r JOIN bookings b ON b.id = r.booking_id WHERE ${where}`,
      params,
    )) as { total: number }[];
    const rows = (await this.dataSource.query(
      `SELECT ${PROVIDER_REVIEW_COLUMNS} ${PROVIDER_REVIEW_FROM}
       WHERE ${where}
       ORDER BY ${ORDER_BY[query.sort]}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.limit, toPageOffset(query.page, query.limit)],
    )) as ProviderReviewRow[];

    return {
      items: rows.map(toProviderReviewView),
      meta: buildPaginationMeta(query.page, query.limit, total),
      query: echo(anchor),
    };
  }

  /**
   * Creates the single provider response of a review (D2: create once).
   *
   * One READ COMMITTED transaction. Lock order is review -> provider ->
   * user -> session:
   * - review -> provider is the order of admin hide/restore (review FOR
   *   UPDATE, then provider FOR UPDATE); the reverse order could deadlock
   *   with it. Review creation locks booking -> provider and never locks an
   *   existing review.
   * - user -> session is the order of login/refresh and account suspension.
   *
   * The provider, user and session rows are only read FOR SHARE, so admin
   * suspension of the provider or the account, and logout, either commit
   * first (and are seen here) or wait until this response commits.
   * `responded_by` is the authenticated user and `responded_at` is the
   * database clock; neither can come from the request.
   */
  async respond(
    user: AuthenticatedUser,
    reviewId: string,
    text: string,
  ): Promise<ProviderReviewView> {
    return this.dataSource.transaction(async (manager) => {
      // 1. Policy before any resource lookup (provider lifecycle matrix).
      const provider = await this.ownershipService.getOwnedProvider(user.id, manager);
      assertProviderCanRespondToReviews(provider);

      // 2. Lock the review, scoped to the caller's provider. A review of
      //    another provider is indistinguishable from a missing one.
      const [review] = (await manager.query(
        `SELECT r.is_visible, (r.provider_response IS NOT NULL) AS responded
           FROM reviews r JOIN bookings b ON b.id = r.booking_id
          WHERE r.id = $1 AND b.provider_id = $2
          FOR UPDATE OF r`,
        [reviewId, provider.id],
      )) as { is_visible: boolean; responded: boolean }[];
      if (!review) {
        throw new NotFoundException(REVIEW_NOT_FOUND);
      }

      // 3. Re-validate authority under share locks (after the review lock).
      const [locked] = (await manager.query(
        `SELECT owner_id::text AS owner_id, approval_status FROM providers WHERE id = $1 FOR SHARE`,
        [provider.id],
      )) as { owner_id: string; approval_status: Provider['approvalStatus'] }[];
      if (!locked || locked.owner_id !== user.id) {
        throw new NotFoundException(REVIEW_NOT_FOUND);
      }
      assertProviderCanRespondToReviews({ approvalStatus: locked.approval_status });
      await this.assertActorStillAuthorized(manager, user);

      // 4. State checks.
      if (!review.is_visible) {
        throw new ConflictException(REVIEW_HIDDEN_CONFLICT);
      }
      if (review.responded) {
        throw new ConflictException(REVIEW_ALREADY_RESPONDED);
      }

      // 5. Guarded write: never overwrites an existing response.
      const updated = (await manager.query(
        `UPDATE reviews
            SET provider_response = $2, responded_by = $3, responded_at = now(), updated_at = now()
          WHERE id = $1 AND provider_response IS NULL AND is_visible
          RETURNING id`,
        [reviewId, text, user.id],
      )) as [unknown[], number];
      if (updated[1] !== 1) {
        throw new ConflictException(REVIEW_ALREADY_RESPONDED);
      }

      const [row] = (await manager.query(
        `SELECT ${PROVIDER_REVIEW_COLUMNS} ${PROVIDER_REVIEW_FROM} WHERE r.id = $1 AND b.provider_id = $2`,
        [reviewId, provider.id],
      )) as ProviderReviewRow[];

      // Ids only: the response text is customer-facing content, not log data.
      this.logger.log(`Provider ${provider.id} responded to review ${reviewId} (user ${user.id})`);

      return toProviderReviewView(row);
    });
  }


  /**
   * The JWT guard checked the account and session at the start of the
   * request; this re-checks them under FOR SHARE inside the write, so an
   * account suspension, role change or logout committed meanwhile is
   * honoured (401/403) instead of being raced.
   */
  private async assertActorStillAuthorized(
    manager: EntityManager,
    user: AuthenticatedUser,
  ): Promise<void> {
    const [account] = (await manager.query(
      `SELECT role, status FROM users WHERE id = $1 FOR SHARE`,
      [user.id],
    )) as { role: string; status: string }[];
    const [session] = (await manager.query(
      `SELECT (revoked_at IS NULL AND expires_at > now()) AS active
         FROM auth_sessions WHERE id = $1 AND user_id = $2 FOR SHARE`,
      [user.sessionId, user.id],
    )) as { active: boolean }[];

    if (!account || account.status !== 'ACTIVE' || !session?.active) {
      // Same body as the JWT guard's 401.
      throw new UnauthorizedException();
    }
    if (account.role !== 'PROVIDER_OWNER') {
      throw new ForbiddenException('Only the provider owner can respond to reviews');
    }
  }
}
