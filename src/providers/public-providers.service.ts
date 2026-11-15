import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

import {
  buildPaginationMeta,
  type PaginatedResult,
  toContainsPattern,
  tokenizeSearchKeyword,
  toPageOffset,
} from '../common/utils/public-search.util';
import { Service } from '../services/entities/service.entity';
import {
  type PublicProviderSearchQueryDto,
  type PublicProviderSort,
} from './dto/public-provider-search-query.dto';
import { Provider } from './entities/provider.entity';

export interface PublicProviderSearchItem {
  id: string;
  businessName: string;
  address: string;
  description: string | null;
  ratingAvg: string;
  ratingCount: number;
  serviceCount: number;
  minPrice: string | null;
  maxPrice: string | null;
}

/** Normalized filters echoed back so clients can sync URLs and drop stale responses. */
export interface PublicProviderSearchEcho {
  q: string | null;
  categoryId: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  minRating: number | null;
  location: string | null;
  sort: PublicProviderSort;
}

type OfferFilters = Pick<
  PublicProviderSearchQueryDto,
  'categoryId' | 'minPrice' | 'maxPrice'
>;

interface PublicProviderSearchRow {
  id: string;
  businessName: string;
  address: string;
  description: string | null;
  ratingAvg: string;
  ratingCount: number;
  serviceCount: string | null;
  minPrice: string | null;
  maxPrice: string | null;
}

/**
 * Whitelisted ORDER BY clauses. Every mode ends with the unique provider ID,
 * so equal sort keys never reorder between pages.
 */
const PUBLIC_PROVIDER_ORDER: Record<
  PublicProviderSort,
  Array<[string, 'ASC' | 'DESC', ('NULLS FIRST' | 'NULLS LAST')?]>
> = {
  newest: [
    ['provider.createdAt', 'DESC'],
    ['provider.id', 'DESC'],
  ],
  name_asc: [
    ['LOWER(provider.businessName)', 'ASC'],
    ['provider.id', 'ASC'],
  ],
  name_desc: [
    ['LOWER(provider.businessName)', 'DESC'],
    ['provider.id', 'ASC'],
  ],
  rating_desc: [
    ['provider.ratingAvg', 'DESC'],
    ['provider.ratingCount', 'DESC'],
    ['provider.id', 'ASC'],
  ],
  price_asc: [
    ['offers.min_price', 'ASC', 'NULLS LAST'],
    ['provider.id', 'ASC'],
  ],
  price_desc: [
    ['offers.min_price', 'DESC', 'NULLS LAST'],
    ['provider.id', 'ASC'],
  ],
};

@Injectable()
export class PublicProvidersService {
  constructor(
    @InjectRepository(Provider)
    private readonly providersRepository: Repository<Provider>,
  ) {}

  /**
   * Public, paginated provider discovery (`GET /providers/public/search`).
   *
   * - Only APPROVED providers are visible. A provider's "offers" are its
   *   ACTIVE services in ACTIVE categories; nothing else is ever joined,
   *   matched or counted.
   * - `categoryId`, `minPrice` and `maxPrice` keep providers with at least
   *   one offer satisfying all three; `serviceCount`, `minPrice` and
   *   `maxPrice` in the response summarize exactly those offers.
   * - Each keyword term must match the business name, the provider
   *   description, or the name/description/category name of one of its
   *   offers.
   * - Every user value is bound as a parameter; sort keys come from a fixed
   *   whitelist.
   */
  async searchPublicProviders(
    query: PublicProviderSearchQueryDto,
  ): Promise<PaginatedResult<PublicProviderSearchItem, PublicProviderSearchEcho>> {
    const hasOfferFilter =
      query.categoryId !== undefined ||
      query.minPrice !== undefined ||
      query.maxPrice !== undefined;

    const builder = this.createVisibleProviderQuery(query);

    if (hasOfferFilter) {
      builder.andWhere('offers.provider_id IS NOT NULL');
    }

    tokenizeSearchKeyword(query.q).forEach((term, index) => {
      const param = `keyword${index}`;
      const offer = `keywordOffer${index}`;
      const category = `keywordCategory${index}`;
      const matchingOffer = builder
        .subQuery()
        .select('1')
        .from(Service, offer)
        .innerJoin(`${offer}.category`, category)
        .where(`${offer}.providerId = provider.id`)
        .andWhere(`${offer}.status = :activeStatus`)
        .andWhere(`${category}.status = :activeStatus`)
        .andWhere(
          `(${offer}.name ILIKE :${param} OR ${offer}.description ILIKE :${param} OR ${category}.name ILIKE :${param})`,
        )
        .getQuery();

      builder.andWhere(
        `(provider.businessName ILIKE :${param} OR provider.description ILIKE :${param} OR EXISTS ${matchingOffer})`,
        { [param]: toContainsPattern(term) },
      );
    });

    if (query.minRating !== undefined) {
      builder.andWhere('provider.ratingAvg >= :minRating', {
        minRating: query.minRating,
      });
    }

    if (query.location !== undefined) {
      builder.andWhere('provider.address ILIKE :location', {
        location: toContainsPattern(query.location),
      });
    }

    const pageBuilder = this.selectPublicProviderColumns(builder.clone())
      .offset(toPageOffset(query.page, query.limit))
      .limit(query.limit);

    PUBLIC_PROVIDER_ORDER[query.sort].forEach(
      ([expression, direction, nulls], index) => {
        if (index === 0) {
          pageBuilder.orderBy(expression, direction, nulls);
        } else {
          pageBuilder.addOrderBy(expression, direction, nulls);
        }
      },
    );

    const [totalItems, rows] = await Promise.all([
      builder.getCount(),
      pageBuilder.getRawMany<PublicProviderSearchRow>(),
    ]);

    return {
      items: rows.map((row) => this.toPublicProviderItem(row)),
      meta: buildPaginationMeta(query.page, query.limit, totalItems),
      query: {
        q: query.q ?? null,
        categoryId: query.categoryId ?? null,
        minPrice: query.minPrice ?? null,
        maxPrice: query.maxPrice ?? null,
        minRating: query.minRating ?? null,
        location: query.location ?? null,
        sort: query.sort,
      },
    };
  }

  /**
   * Public provider profile (`GET /providers/public/:id`), as one query.
   *
   * Uses the same visibility rule, offer summary and projection as an
   * unfiltered search, so a provider's detail always equals its search item.
   * PENDING, REJECTED, SUSPENDED and missing providers share one 404 (the
   * same message as the public review endpoint), so the response does not
   * reveal whether a hidden provider exists.
   */
  async getPublicProviderById(
    providerId: string,
  ): Promise<PublicProviderSearchItem> {
    const row = await this.selectPublicProviderColumns(
      this.createVisibleProviderQuery({}),
    )
      .andWhere('provider.id = :providerId', { providerId })
      .getRawOne<PublicProviderSearchRow>();

    if (!row) {
      throw new NotFoundException('Provider not found');
    }

    return this.toPublicProviderItem(row);
  }

  /** APPROVED providers left-joined to the summary of their public offers. */
  private createVisibleProviderQuery(offerFilters: OfferFilters) {
    return this.providersRepository
      .createQueryBuilder('provider')
      .setParameters({ approvedStatus: 'APPROVED', activeStatus: 'ACTIVE' })
      .leftJoin(
        (subQuery) => this.buildOfferSummary(subQuery, offerFilters),
        'offers',
        'offers.provider_id = provider.id',
      )
      .where('provider.approvalStatus = :approvedStatus');
  }

  /** Explicit public projection: owner, phone and approval metadata are never selected. */
  private selectPublicProviderColumns(
    builder: SelectQueryBuilder<Provider>,
  ) {
    return builder
      .select('provider.id', 'id')
      .addSelect('provider.businessName', 'businessName')
      .addSelect('provider.address', 'address')
      .addSelect('provider.description', 'description')
      .addSelect('provider.ratingAvg', 'ratingAvg')
      .addSelect('provider.ratingCount', 'ratingCount')
      .addSelect('offers.service_count', 'serviceCount')
      .addSelect('offers.min_price', 'minPrice')
      .addSelect('offers.max_price', 'maxPrice');
  }

  private toPublicProviderItem(
    row: PublicProviderSearchRow,
  ): PublicProviderSearchItem {
    return {
      id: String(row.id),
      businessName: row.businessName,
      address: row.address,
      description: row.description,
      ratingAvg: row.ratingAvg,
      ratingCount: Number(row.ratingCount),
      serviceCount: Number(row.serviceCount ?? 0),
      minPrice: row.minPrice ?? null,
      maxPrice: row.maxPrice ?? null,
    };
  }

  /**
   * One row per provider with at least one offer matching the offer filters:
   * `provider_id`, `service_count`, `min_price`, `max_price`.
   */
  private buildOfferSummary(
    subQuery: SelectQueryBuilder<ObjectLiteral>,
    query: OfferFilters,
  ) {
    subQuery
      .select('offer.providerId', 'provider_id')
      .addSelect('COUNT(*)', 'service_count')
      .addSelect('MIN(offer.price)', 'min_price')
      .addSelect('MAX(offer.price)', 'max_price')
      .from(Service, 'offer')
      .innerJoin('offer.category', 'offerCategory')
      .where('offer.status = :activeStatus')
      .andWhere('offerCategory.status = :activeStatus');

    if (query.categoryId !== undefined) {
      subQuery.andWhere('offer.categoryId = :categoryId', {
        categoryId: query.categoryId,
      });
    }

    if (query.minPrice !== undefined) {
      subQuery.andWhere('offer.price >= :minPrice', {
        minPrice: query.minPrice,
      });
    }

    if (query.maxPrice !== undefined) {
      subQuery.andWhere('offer.price <= :maxPrice', {
        maxPrice: query.maxPrice,
      });
    }

    return subQuery.groupBy('offer.providerId');
  }
}
