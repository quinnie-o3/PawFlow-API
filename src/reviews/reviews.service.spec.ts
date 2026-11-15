import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { DataSource } from 'typeorm';

import { AdminReviewsController } from '../admin/admin-reviews.controller';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import { Provider } from '../providers/entities/provider.entity';
import { Review } from './entities/review.entity';
import { ReviewQueriesController } from './review-queries.controller';
import { ReviewsService } from './reviews.service';

type ReviewRow = {
  id: string;
  rating: number;
  comment: string | null;
  providerResponse: string | null;
  respondedAt: Date | null;
  createdAt: Date;
  isVisible: boolean;
  booking: { providerId: string; customerId: string };
};

const PUBLIC_REVIEW_FIELDS = [
  'id',
  'rating',
  'comment',
  'providerResponse',
  'respondedAt',
  'createdAt',
];

/**
 * Minimal stand-in for the review SelectQueryBuilder: evaluates the real
 * `booking.providerId` / `booking.customerId` / `review.isVisible` conditions
 * and applies the selected column projection.
 */
function createReviewQueryBuilder(rows: ReviewRow[]) {
  let selected: string[] | null = null;
  const conditions: Array<(row: ReviewRow) => boolean> = [];

  const addCondition = (expression: string, params: Record<string, unknown>) => {
    if (expression === 'booking.providerId = :providerId') {
      conditions.push((row) => row.booking.providerId === params.providerId);
    } else if (expression === 'booking.customerId = :customerId') {
      conditions.push((row) => row.booking.customerId === params.customerId);
    } else if (expression === 'review.isVisible = :isVisible') {
      conditions.push((row) => row.isVisible === params.isVisible);
    } else {
      throw new Error(`Unsupported condition in fake: ${expression}`);
    }
  };

  const builder: Record<string, jest.Mock> = {};

  Object.assign(builder, {
    select: jest.fn((columns: string[]) => {
      selected = columns.map((column) => column.replace('review.', ''));
      return builder;
    }),
    innerJoin: jest.fn(() => builder),
    where: jest.fn((expression: string, params: Record<string, unknown>) => {
      addCondition(expression, params);
      return builder;
    }),
    andWhere: jest.fn((expression: string, params: Record<string, unknown>) => {
      addCondition(expression, params);
      return builder;
    }),
    orderBy: jest.fn(() => builder),
    getMany: jest.fn(() =>
      Promise.resolve(
        rows
          .filter((row) => conditions.every((condition) => condition(row)))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((row) =>
            selected
              ? Object.fromEntries(
                  selected.map((key) => [key, row[key as keyof ReviewRow]]),
                )
              : row,
          ),
      ),
    ),
  });

  return builder;
}

describe('ReviewsService public and customer queries', () => {
  const providers: Array<Partial<Provider>> = [
    { id: '1', ownerId: '71', approvalStatus: 'APPROVED' },
    { id: '2', ownerId: '72', approvalStatus: 'PENDING' },
    { id: '3', ownerId: '73', approvalStatus: 'REJECTED' },
    { id: '4', ownerId: '74', approvalStatus: 'SUSPENDED' },
    { id: '5', ownerId: '75', approvalStatus: 'APPROVED' },
  ];

  const review = (
    id: string,
    providerId: string,
    overrides: Partial<ReviewRow> = {},
  ): ReviewRow => ({
    id,
    rating: 4,
    comment: `Review ${id}`,
    providerResponse: null,
    respondedAt: null,
    createdAt: new Date(`2026-10-${10 + Number(id)}T00:00:00.000Z`),
    isVisible: true,
    booking: { providerId, customerId: '10' },
    ...overrides,
  });

  const reviews: ReviewRow[] = [
    review('1', '1'),
    review('2', '1', { isVisible: false }),
    review('3', '1', { booking: { providerId: '1', customerId: '11' } }),
    review('4', '2'),
    review('5', '3'),
    review('6', '4'),
  ];

  let service: ReviewsService;

  beforeEach(() => {
    const providersRepository = {
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          providers.find((provider) =>
            Object.entries(where).every(
              ([key, value]) => provider[key as keyof Provider] === value,
            ),
          ) ?? null,
        ),
      ),
    };
    const reviewsRepository = {
      createQueryBuilder: jest.fn(() => createReviewQueryBuilder(reviews)),
    };
    const repositories = new Map<unknown, unknown>([
      [Provider, providersRepository],
      [Review, reviewsRepository],
    ]);

    service = new ReviewsService({
      getRepository: jest.fn((entity: unknown) => repositories.get(entity)),
    } as unknown as DataSource);
  });

  describe('getPublicProviderReviews (C-06)', () => {
    it('returns visible reviews of an APPROVED provider, newest first', async () => {
      const result = await service.getPublicProviderReviews('1');

      expect(result.map((item) => item.id)).toEqual(['3', '1']);
    });

    it('keeps hidden reviews hidden', async () => {
      const result = await service.getPublicProviderReviews('1');

      expect(result.map((item) => item.id)).not.toContain('2');
    });

    it('returns an empty list for an APPROVED provider without visible reviews', async () => {
      await expect(service.getPublicProviderReviews('5')).resolves.toEqual([]);
    });

    it('preserves the public review contract (no booking, customer or provider ids)', async () => {
      const [first] = await service.getPublicProviderReviews('1');

      expect(Object.keys(first).sort()).toEqual([...PUBLIC_REVIEW_FIELDS].sort());
      expect(JSON.stringify(first)).not.toMatch(
        /"(ownerId|customerId|providerId|bookingId|isVisible|approvalStatus)"/,
      );
    });

    it.each([
      ['2', 'PENDING'],
      ['3', 'REJECTED'],
      ['4', 'SUSPENDED'],
      ['999', 'nonexistent'],
    ])('returns the same 404 for provider %s (%s)', async (providerId) => {
      await expect(service.getPublicProviderReviews(providerId)).rejects.toThrow(
        new NotFoundException('Provider not found'),
      );
    });

    it.each(['abc', '0', '-1', '9223372036854775808'])(
      'rejects invalid provider id %p with 400 (route pipe)',
      (providerId) => {
        expect(() => new ParseBigIntIdPipe().transform(providerId)).toThrow(
          BadRequestException,
        );
      },
    );
  });

  describe('getMyReviews (customer-owned, unchanged)', () => {
    it('returns all of the customer’s reviews, including hidden ones', async () => {
      const result = await service.getMyReviews('10');

      expect(result.map((item) => (item as unknown as ReviewRow).id).sort()).toEqual([
        '1',
        '2',
        '4',
        '5',
        '6',
      ]);
    });

    it('does not return another customer’s reviews', async () => {
      const result = await service.getMyReviews('11');

      expect(result.map((item) => (item as unknown as ReviewRow).id)).toEqual(['3']);
    });
  });

  describe('route protection (unchanged)', () => {
    it('keeps public provider reviews unauthenticated', () => {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, ReviewQueriesController),
      ).toBeUndefined();
      expect(
        Reflect.getMetadata(
          GUARDS_METADATA,
          ReviewQueriesController.prototype.getPublicProviderReviews,
        ),
      ).toBeUndefined();
    });

    it('keeps /reviews/mine behind JWT + CUSTOMER', () => {
      const handler = ReviewQueriesController.prototype.getMyReviews;

      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
        JwtAuthGuard,
        RolesGuard,
      ]);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['CUSTOMER']);
    });

    it('keeps admin review moderation behind JWT + ADMIN', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, AdminReviewsController)).toEqual([
        JwtAuthGuard,
        RolesGuard,
      ]);
      expect(Reflect.getMetadata(ROLES_KEY, AdminReviewsController)).toEqual([
        'ADMIN',
      ]);
    });
  });
});
