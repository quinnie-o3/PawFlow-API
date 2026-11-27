import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import {
  OwnershipService,
  PROVIDER_PROFILE_NOT_FOUND,
  STAFF_ASSOCIATION_REQUIRED,
} from '../auth/authorization/ownership.service';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../common/pipes/validation-pipe.options';
import { ProviderStaff } from '../providers/entities/provider-staff.entity';
import { Provider } from '../providers/entities/provider.entity';
import { assertProviderCanRespondToReviews } from '../providers/provider-lifecycle.policy';
import { CreateReviewResponseDto } from './dto/create-review-response.dto';
import { ProviderReviewListQueryDto } from './dto/provider-review-list-query.dto';
import { ProviderReviewsController } from './provider-reviews.controller';
import {
  REVIEW_ALREADY_RESPONDED,
  REVIEW_HIDDEN_CONFLICT,
  REVIEW_NOT_FOUND,
  ProviderReviewsService,
} from './provider-reviews.service';
import { codePointLength, normalizeReviewResponseText } from './review-response-text';
import { expectAuthenticated } from '../../test/helpers/auth-metadata';

const pipe = new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);
const body = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: CreateReviewResponseDto });
const query = (value: unknown) =>
  pipe.transform(value, { type: 'query', metatype: ProviderReviewListQueryDto });

const SESSION = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const userOf = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser =>
  ({ id, role, status: 'ACTIVE', sessionId: SESSION }) as AuthenticatedUser;
const OWNER = userOf('10', 'PROVIDER_OWNER');
const STAFF = userOf('20', 'PROVIDER_STAFF');

const ROW = {
  id: '41', rating: 2, comment: 'Late', is_visible: true, created_at: new Date('2026-11-10T08:00:00Z'),
  booking_id: '310', service_id: '7', service_name: 'Grooming', slot_date: '2026-11-09', start_time: '09:00:00',
  customer_full_name: 'Nguyen An', provider_response: 'Thanks', responded_at: new Date('2026-11-10T09:00:00Z'),
  responded_by: '10', responder_full_name: 'Owner',
};

type State = {
  provider?: { id: string; approval_status: string } | null;
  lockedProvider?: { owner_id: string; approval_status: string } | null;
  staff?: { provider_id: string } | null;
  review?: { is_visible: boolean; responded: boolean } | null;
  account?: { role: string; status: string } | null;
  session?: { active: boolean } | null;
  updated?: number;
  anchor?: string | null;
};

/** Fake DataSource: answers each SQL statement from `state` and records the order. */
function harness(initial: State = {}) {
  const state: State = {
    provider: { id: '1', approval_status: 'APPROVED' },
    lockedProvider: { owner_id: '10', approval_status: 'APPROVED' },
    staff: { provider_id: '1' },
    review: { is_visible: true, responded: false },
    account: { role: 'PROVIDER_OWNER', status: 'ACTIVE' },
    session: { active: true },
    updated: 1,
    anchor: '41',
    ...initial,
  };
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const one = <T>(value: T | null | undefined) => Promise.resolve(value ? [value] : []);
    if (sql.includes('FOR UPDATE OF r')) return one(state.review);
    if (sql.includes('FROM providers WHERE id = $1 FOR SHARE')) return one(state.lockedProvider);
    if (sql.includes('FROM users WHERE id = $1 FOR SHARE')) return one(state.account);
    if (sql.includes('FROM auth_sessions')) return one(state.session);
    if (sql.includes('UPDATE reviews')) return Promise.resolve([[], state.updated]);
    if (sql.includes('max(r.id)')) return Promise.resolve([{ max: state.anchor }]);
    if (sql.includes('count(*)::int AS total')) return Promise.resolve([{ total: 1 }]);
    return Promise.resolve([ROW]);
  });
  // OwnershipService resolves the caller's provider through repositories;
  // record those lookups in `calls` like SQL so ordering assertions see them.
  const lookup = (sql: string, params: unknown[], row: unknown) => {
    calls.push({ sql, params });
    return Promise.resolve(row ?? null);
  };
  const getRepository = (entity: unknown) => ({
    findOne: ({ where }: { where: Record<string, unknown> }) =>
      entity === Provider
        ? lookup('FROM providers WHERE owner_id = $1', [where.ownerId], state.provider && {
          id: state.provider.id, approvalStatus: state.provider.approval_status,
        })
        : entity === ProviderStaff
          ? lookup(`FROM provider_staff WHERE user_id = $1 AND status = '${String(where.status)}'`, [where.userId], state.staff && {
            providerId: state.staff.provider_id,
          })
          : Promise.reject(new Error('unexpected repository')),
  });
  const manager = { query, getRepository };
  const dataSource = {
    manager,
    query,
    transaction: (fn: (m: typeof manager) => unknown) => fn(manager),
  } as unknown as DataSource;
  const kinds = () =>
    calls.map(({ sql }) =>
      sql.includes('FOR UPDATE OF r') ? 'review:update'
        : sql.includes('FROM providers WHERE id = $1 FOR SHARE') ? 'provider:share'
          : sql.includes('FROM users WHERE id = $1 FOR SHARE') ? 'user:share'
            : sql.includes('FROM auth_sessions') ? 'session:share'
              : sql.includes('UPDATE reviews') ? 'write'
                : sql.includes('FROM providers WHERE owner_id') ? 'provider:resolve'
                  : 'read');
  return {
    service: new ProviderReviewsService(dataSource, new OwnershipService(dataSource)),
    calls,
    kinds,
    state,
  };
}

const LIST_DEFAULTS = { page: 1, limit: 20, visibility: 'all', responded: 'all', sort: 'newest' } as const;

describe('Provider feedback (P3-BE08-02)', () => {
  describe('routes and guards', () => {
    it('mounts under /providers/me/reviews and requires authentication', () => {
      expect(Reflect.getMetadata(PATH_METADATA, ProviderReviewsController)).toBe('providers/me/reviews');
      expectAuthenticated(ProviderReviewsController);
    });

    it('list: owner and staff only (D1)', () => {
      const handler = ProviderReviewsController.prototype.list;
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['PROVIDER_OWNER', 'PROVIDER_STAFF']);
    });

    it('respond: owner only, POST :reviewId/response, 201 (D1, D2)', () => {
      const handler = ProviderReviewsController.prototype.respond;
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':reviewId/response');
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['PROVIDER_OWNER']);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(201);
    });
  });

  describe('response text (D8)', () => {
    it('normalizes CRLF/CR to LF and trims', async () => {
      await expect(body({ text: '  Hi\r\nthere\rfriend  \n' })).resolves.toMatchObject({ text: 'Hi\nthere\nfriend' });
    });

    it('counts Unicode code points like PostgreSQL char_length', async () => {
      const emoji = '\u{1F436}'.repeat(1000);
      expect(emoji.length).toBe(2000);
      expect(codePointLength(emoji)).toBe(1000);
      await expect(body({ text: emoji })).resolves.toMatchObject({ text: emoji });
      await expect(body({ text: emoji + '\u{1F436}' })).rejects.toThrow();
      await expect(body({ text: 'a'.repeat(1000) })).resolves.toBeDefined();
      await expect(body({ text: 'a'.repeat(1001) })).rejects.toThrow();
      await expect(body({ text: ` ${'a'.repeat(1000)}  ` })).resolves.toMatchObject({ text: 'a'.repeat(1000) });
    });

    it.each([
      ['missing', {}],
      ['empty', { text: '' }],
      ['whitespace only', { text: ' \t\r\n  ' }],
      ['NUL', { text: 'a\u0000b' }],
      ['number', { text: 5 }],
      ['null', { text: null }],
      ['array', { text: ['a'] }],
      ['respondedBy', { text: 'ok', respondedBy: '99' }],
      ['respondedAt', { text: 'ok', respondedAt: '2000-01-01T00:00:00Z' }],
      ['providerId', { text: 'ok', providerId: '2' }],
      ['userId', { text: 'ok', userId: '2' }],
    ])('rejects %s with 400', async (_label, value) => {
      await expect(body(value)).rejects.toThrow();
    });

    it('leaves non-strings to the validator', () => {
      expect(normalizeReviewResponseText(7)).toBe(7);
    });
  });

  describe('list query', () => {
    it('applies defaults', async () => {
      await expect(query({})).resolves.toMatchObject(LIST_DEFAULTS);
    });

    it.each([
      ['page 0', { page: '0' }],
      ['limit 51', { limit: '51' }],
      ['rating 6', { rating: '6' }],
      ['rating 2.5', { rating: '2.5' }],
      ['bad maxId', { maxId: 'abc' }],
      ['bad sort', { sort: 'random' }],
      ['bad visibility', { visibility: 'deleted' }],
      ['bad responded', { responded: 'yes' }],
      ['providerId', { providerId: '2' }],
    ])('rejects %s with 400', async (_label, value) => {
      await expect(query(value)).rejects.toThrow();
    });
  });

  describe('list scope', () => {
    it('owner: scope is the owned provider, in SQL, with a total-ordered sort', async () => {
      const h = harness();
      const result = await h.service.list(OWNER, { ...LIST_DEFAULTS, rating: 2, visibility: 'hidden', responded: 'unresponded', sort: 'rating_asc' });

      expect(h.calls[0].params).toEqual(['10']);
      const page = h.calls.find((c) => c.sql.includes('ORDER BY'))!;
      expect(page.params.slice(0, 3)).toEqual(['1', '41', 2]);
      expect(page.sql).toContain('b.provider_id = $1');
      expect(page.sql).toContain('NOT r.is_visible');
      expect(page.sql).toContain('r.provider_response IS NULL');
      expect(page.sql).toMatch(/ORDER BY r\.rating ASC, r\.created_at DESC, r\.id DESC/);
      expect(result.query).toEqual({ rating: 2, visibility: 'hidden', responded: 'unresponded', sort: 'rating_asc', maxId: '41' });
      expect(result.items[0]).toEqual({
        id: '41', rating: 2, comment: 'Late', isVisible: true, createdAt: ROW.created_at,
        booking: { id: '310', service: { id: '7', name: 'Grooming' }, slot: { slotDate: '2026-11-09', startTime: '09:00:00' } },
        customer: { fullName: 'Nguyen An' },
        response: { text: 'Thanks', respondedAt: ROW.responded_at, respondedBy: { id: '10', fullName: 'Owner' } },
      });
    });

    it('anchor is computed inside the provider scope', async () => {
      const h = harness();
      await h.service.list(OWNER, { ...LIST_DEFAULTS });
      const anchor = h.calls.find((c) => c.sql.includes('max(r.id)'))!;
      expect(anchor.sql).toContain('WHERE b.provider_id = $1');
      expect(anchor.params).toEqual(['1']);
    });

    it('active staff: scope is the staff provider', async () => {
      const h = harness({ staff: { provider_id: '5' } });
      await h.service.list(STAFF, { ...LIST_DEFAULTS });
      expect(h.calls[0].sql).toContain("status = 'ACTIVE'");
      expect(h.calls.find((c) => c.sql.includes('max(r.id)'))!.params).toEqual(['5']);
    });

    it('staff without an ACTIVE association -> 403', async () => {
      await expect(harness({ staff: null }).service.list(STAFF, { ...LIST_DEFAULTS })).rejects.toThrow(new ForbiddenException(STAFF_ASSOCIATION_REQUIRED));
    });

    it('owner without a provider -> 404', async () => {
      await expect(harness({ provider: null }).service.list(OWNER, { ...LIST_DEFAULTS })).rejects.toThrow(new NotFoundException(PROVIDER_PROFILE_NOT_FOUND));
    });

    it('any other role -> 403 even without the guard', async () => {
      await expect(harness().service.list(userOf('3', 'ADMIN'), { ...LIST_DEFAULTS })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('suspended provider can still read (D5)', async () => {
      const h = harness({ provider: { id: '1', approval_status: 'SUSPENDED' } });
      await expect(h.service.list(OWNER, { ...LIST_DEFAULTS })).resolves.toMatchObject({ meta: { totalItems: 1 } });
    });

    it('no reviews -> empty page, maxId null', async () => {
      const result = await harness({ anchor: null }).service.list(OWNER, { ...LIST_DEFAULTS });
      expect(result).toEqual({
        items: [],
        meta: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false },
        query: { rating: null, visibility: 'all', responded: 'all', sort: 'newest', maxId: null },
      });
    });
  });

  describe('respond', () => {
    it('writes text, the authenticated user and the database clock, after locking review -> provider -> user -> session', async () => {
      const h = harness();
      const result = await h.service.respond(OWNER, '41', 'Thanks');

      expect(h.kinds()).toEqual(['provider:resolve', 'review:update', 'provider:share', 'user:share', 'session:share', 'write', 'read']);
      const write = h.calls.find((c) => c.sql.includes('UPDATE reviews'))!;
      expect(write.params).toEqual(['41', 'Thanks', '10']);
      expect(write.sql).toContain('responded_at = now()');
      expect(write.sql).toContain('provider_response IS NULL AND is_visible');
      expect(h.calls.find((c) => c.sql.includes('FOR UPDATE OF r'))!.params).toEqual(['41', '1']);
      expect(result.response?.respondedBy).toEqual({ id: '10', fullName: 'Owner' });
    });

    it.each(['SUSPENDED', 'PENDING', 'REJECTED'])('%s provider -> 403 before any review lookup', async (status) => {
      const h = harness({ provider: { id: '1', approval_status: status } });
      await expect(h.service.respond(OWNER, '41', 'x')).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.kinds()).toEqual(['provider:resolve']);
    });

    it('owner without provider -> 404', async () => {
      await expect(harness({ provider: null }).service.respond(OWNER, '41', 'x')).rejects.toThrow(new NotFoundException(PROVIDER_PROFILE_NOT_FOUND));
    });

    it('missing or foreign review -> 404 Review not found, nothing written', async () => {
      const h = harness({ review: null });
      await expect(h.service.respond(OWNER, '41', 'x')).rejects.toThrow(new NotFoundException(REVIEW_NOT_FOUND));
      expect(h.kinds()).not.toContain('write');
    });

    it('suspended while waiting for the lock -> 403', async () => {
      const h = harness({ lockedProvider: { owner_id: '10', approval_status: 'SUSPENDED' } });
      await expect(h.service.respond(OWNER, '41', 'x')).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.kinds()).not.toContain('write');
    });

    it('ownership changed while waiting for the lock -> 404', async () => {
      const h = harness({ lockedProvider: { owner_id: '99', approval_status: 'APPROVED' } });
      await expect(h.service.respond(OWNER, '41', 'x')).rejects.toThrow(new NotFoundException(REVIEW_NOT_FOUND));
    });

    it.each([
      ['account suspended', { account: { role: 'PROVIDER_OWNER', status: 'SUSPENDED' } }],
      ['session revoked/expired', { session: { active: false } }],
      ['session missing', { session: null }],
    ])('%s meanwhile -> 401', async (_label, state) => {
      const h = harness(state as State);
      await expect(h.service.respond(OWNER, '41', 'x')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(h.kinds()).not.toContain('write');
    });

    it('role changed meanwhile -> 403', async () => {
      await expect(harness({ account: { role: 'CUSTOMER', status: 'ACTIVE' } }).service.respond(OWNER, '41', 'x')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('hidden review -> 409 (D4)', async () => {
      await expect(harness({ review: { is_visible: false, responded: false } }).service.respond(OWNER, '41', 'x')).rejects.toThrow(new ConflictException(REVIEW_HIDDEN_CONFLICT));
    });

    it('already responded -> 409 (D2)', async () => {
      const h = harness({ review: { is_visible: true, responded: true } });
      await expect(h.service.respond(OWNER, '41', 'x')).rejects.toThrow(new ConflictException(REVIEW_ALREADY_RESPONDED));
      expect(h.kinds()).not.toContain('write');
    });

    it('guarded UPDATE matching no row -> 409', async () => {
      await expect(harness({ updated: 0 }).service.respond(OWNER, '41', 'x')).rejects.toThrow(new ConflictException(REVIEW_ALREADY_RESPONDED));
    });
  });

  describe('lifecycle policy', () => {
    it('only APPROVED providers may respond', () => {
      expect(() => assertProviderCanRespondToReviews({ approvalStatus: 'APPROVED' })).not.toThrow();
      for (const status of ['PENDING', 'REJECTED', 'SUSPENDED'] as const) {
        expect(() => assertProviderCanRespondToReviews({ approvalStatus: status })).toThrow(`A ${status} provider cannot respond to reviews`);
      }
    });
  });
});
