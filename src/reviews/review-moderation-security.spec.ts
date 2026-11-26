import { ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { QueryRunner } from 'typeorm';

import { AdminReviewsController } from '../admin/admin-reviews.controller';
import { AdminService } from '../admin/admin.service';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../common/pipes/validation-pipe.options';
import { AddReviewResponseConstraints1797500000000 } from '../database/migrations/1797500000000-AddReviewResponseConstraints';
import { CreateReviewResponseDto } from './dto/create-review-response.dto';
import { ProviderReviewsController } from './provider-reviews.controller';
import {
  REVIEW_RESPONSE_CONSISTENCY_CHECK,
  REVIEW_RESPONSE_TEXT_CHECK,
  REVIEW_RESPONSE_TRIM_CODE_POINTS,
  codePointLength,
} from './review-response-text';
import { expectAuthenticated } from '../../test/helpers/auth-metadata';

const pipe = new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);
const body = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: CreateReviewResponseDto });

/** Every code point that ECMAScript `trim` removes, computed on this runtime. */
function jsTrimSet(): number[] {
  const set: number[] = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    if (String.fromCodePoint(c).trim() === '') set.push(c);
  }
  return set;
}

describe('Review moderation security (P3-BE08-03)', () => {
  describe('database CHECK vs application normalization', () => {
    it('the CHECK trim set is exactly the ECMAScript trim set', () => {
      expect([...REVIEW_RESPONSE_TRIM_CODE_POINTS]).toEqual(jsTrimSet());
    });

    it('the pending migration installs exactly the entity CHECK expressions (after a clean preflight)', async () => {
      const sql: string[] = [];
      const runner = {
        query: (q: string) => {
          sql.push(q);
          return Promise.resolve(q.startsWith('SELECT') ? [{ inconsistent: 0, invalid_text: 0 }] : []);
        },
      } as unknown as QueryRunner;

      await new AddReviewResponseConstraints1797500000000().up(runner);

      expect(sql[1]).toBe(`ALTER TABLE "reviews" ADD CONSTRAINT "chk_reviews_response_consistency" CHECK (${REVIEW_RESPONSE_CONSISTENCY_CHECK})`);
      expect(sql[2]).toBe(`ALTER TABLE "reviews" ADD CONSTRAINT "chk_reviews_response_text" CHECK (${REVIEW_RESPONSE_TEXT_CHECK})`);
    });

    it('the migration preflight aborts with counts only and adds nothing', async () => {
      const sql: string[] = [];
      const runner = {
        query: (q: string) => {
          sql.push(q);
          return Promise.resolve([{ inconsistent: 2, invalid_text: 1 }]);
        },
      } as unknown as QueryRunner;

      await expect(new AddReviewResponseConstraints1797500000000().up(runner)).rejects.toThrow('2 review(s) with inconsistent response columns, 1 with invalid response text');
      expect(sql).toHaveLength(1);
    });
  });

  describe('Unicode rules of the response DTO', () => {
    it('distinguishes code points (the rule) from UTF-16 units and graphemes', async () => {
      const combining = 'é'.repeat(500); // 500 graphemes, 1000 code points
      expect(combining.length).toBe(1000);
      expect(codePointLength(combining)).toBe(1000);
      await expect(body({ text: combining })).resolves.toMatchObject({ text: combining });
      await expect(body({ text: combining + '́' })).rejects.toThrow(); // 1001 code points

      const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // 1 grapheme, 5 code points, 8 UTF-16 units
      expect(codePointLength(family)).toBe(5);
      await expect(body({ text: family.repeat(200) })).resolves.toBeDefined(); // 1000 code points
      await expect(body({ text: family.repeat(200) + 'x' })).rejects.toThrow();
    });

    it.each([
      ['NBSP only', ' '],
      ['ideographic space only', '　　'],
      ['BOM and line separator only', '﻿  '],
      ['mixed Unicode whitespace', ' \t    \r\n'],
    ])('rejects %s (blank after trim)', async (_label, text) => {
      await expect(body({ text })).rejects.toThrow();
    });

    it('trims Unicode whitespace at the ends and keeps it inside', async () => {
      await expect(body({ text: '　 Xin chào \n' })).resolves.toMatchObject({ text: 'Xin chào' });
    });

    it('does not apply Unicode normalization (precomposed and decomposed forms are stored as sent)', async () => {
      await expect(body({ text: 'café' })).resolves.toMatchObject({ text: 'café' });
      await expect(body({ text: 'café' })).resolves.toMatchObject({ text: 'café' });
    });
  });

  describe('admin review projection', () => {
    const service = new AdminService({} as never, {} as never) as unknown as {
      toSafeReviewResponse: (review: unknown) => Record<string, unknown>;
    };
    const base = {
      id: '41', bookingId: '310', rating: 2, comment: 'Late', isVisible: false,
      createdAt: new Date(0), updatedAt: new Date(0),
      booking: { id: '310', customerId: '7', providerId: '1', serviceId: '3', status: 'COMPLETED' },
    };

    it('exposes the responder as { id, fullName } only', () => {
      const view = service.toSafeReviewResponse({
        ...base, providerResponse: 'Sorry', respondedAt: new Date(1),
        respondedByUser: { id: '10', fullName: 'Owner', email: 'o@x.test', phone: '0900', passwordHash: 'h', role: 'PROVIDER_OWNER' },
      });

      expect(view.respondedBy).toEqual({ id: '10', fullName: 'Owner' });
      expect(view).toMatchObject({ providerResponse: 'Sorry', respondedAt: new Date(1), isVisible: false });
      expect(JSON.stringify(view)).not.toMatch(/o@x\.test|0900|passwordHash|PROVIDER_OWNER/);
    });

    it('no response -> providerResponse, respondedBy and respondedAt all null', () => {
      const view = service.toSafeReviewResponse({ ...base, providerResponse: null, respondedAt: null, respondedByUser: null });
      expect([view.providerResponse, view.respondedBy, view.respondedAt]).toEqual([null, null, null]);
    });

    it('deleted responder -> respondedBy null, text and time kept (no fabricated responder)', () => {
      const view = service.toSafeReviewResponse({ ...base, providerResponse: 'Kept', respondedAt: new Date(2), respondedByUser: null });
      expect(view).toMatchObject({ providerResponse: 'Kept', respondedAt: new Date(2), respondedBy: null });
    });

    it('keeps key order and set stable for list, detail and hide/restore (single mapper)', () => {
      const view = service.toSafeReviewResponse({ ...base, providerResponse: null, respondedAt: null, respondedByUser: null });
      expect(Object.keys(view)).toEqual(['id', 'bookingId', 'rating', 'comment', 'providerResponse', 'respondedBy', 'respondedAt', 'isVisible', 'createdAt', 'updatedAt', 'booking']);
    });
  });

  describe('moderation stays admin-only', () => {
    it('admin review routes remain JWT + ADMIN', () => {
      expectAuthenticated(AdminReviewsController);
      expect(Reflect.getMetadata(ROLES_KEY, AdminReviewsController)).toEqual(['ADMIN']);
    });

    it('the provider controller exposes only list and the one-time response (no hide, restore, edit or delete)', () => {
      const handlers = Object.getOwnPropertyNames(ProviderReviewsController.prototype).filter((name) => name !== 'constructor');
      expect(handlers.sort()).toEqual(['list', 'respond']);
      const routes = handlers.map((name) => {
        const fn = (ProviderReviewsController.prototype as unknown as Record<string, object>)[name];
        return `${Reflect.getMetadata(METHOD_METADATA, fn)} ${Reflect.getMetadata(PATH_METADATA, fn)}`;
      });
      expect(routes.sort()).toEqual(['0 /', '1 :reviewId/response']); // GET /, POST :reviewId/response
    });

    it.each([
      ['isVisible', { text: 'ok', isVisible: false }],
      ['is_visible', { text: 'ok', is_visible: false }],
      ['adminUserId', { text: 'ok', adminUserId: '1' }],
      ['role', { text: 'ok', role: 'ADMIN' }],
      ['providerResponse', { text: 'ok', providerResponse: 'other' }],
    ])('the response body rejects %s (no moderation or identity fields)', async (_label, value) => {
      await expect(body(value)).rejects.toThrow();
    });
  });
});
