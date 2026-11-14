import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { AdminActivityLogQueryDto } from '../../admin/dto/admin-activity-log-query.dto';
import { UpdateAdminServiceCategoryDto } from '../../admin/dto/update-admin-service-category.dto';
import { RegisterDto } from '../../auth/dto/register.dto';
import { CreateAvailabilitySlotDto } from '../../availability/dto/create-availability-slot.dto';
import { CreateBookingDto } from '../../bookings/dto/create-booking.dto';
import { CreatePetDto } from '../../pets/dto/create-pet.dto';
import { UpdatePetDto } from '../../pets/dto/update-pet.dto';
import { CreateProviderWorkingHourDto } from '../../providers/dto/create-provider-working-hour.dto';
import { UpdateProviderWorkingHourDto } from '../../providers/dto/update-provider-working-hour.dto';
import { CreateReviewDto } from '../../reviews/dto/create-review.dto';
import { CreateServiceDto } from '../../services/dto/create-service.dto';
import { UpdateServiceDto } from '../../services/dto/update-service.dto';
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from './validation-pipe.options';

const pipe = new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);

function body(metatype: new () => object, value: unknown) {
  return pipe.transform(value, { type: 'body', metatype }) as Promise<
    Record<string, unknown>
  >;
}

function query(metatype: new () => object, value: unknown) {
  return pipe.transform(value, { type: 'query', metatype }) as Promise<
    Record<string, unknown>
  >;
}

const workingHour = (extra: object = {}) => ({
  dayOfWeek: 1,
  startTime: '09:00',
  endTime: '17:00',
  ...extra,
});
const service = (extra: object = {}) => ({
  categoryId: '1',
  name: 'Bath',
  price: 10,
  durationMinutes: 30,
  ...extra,
});

describe('GLOBAL_VALIDATION_PIPE_OPTIONS (C-12)', () => {
  it('disables implicit conversion and keeps strict whitelisting', () => {
    expect(GLOBAL_VALIDATION_PIPE_OPTIONS).toMatchObject({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    });
  });

  describe('confirmed invalid inputs are rejected with 400', () => {
    it('isActive "false" is no longer coerced to true', async () => {
      await expect(
        body(CreateProviderWorkingHourDto, workingHour({ isActive: 'false' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rating true is no longer coerced to 1', async () => {
      await expect(body(CreateReviewDto, { rating: true })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('price "" is no longer coerced to 0', async () => {
      await expect(
        body(CreateServiceDto, service({ price: '' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('name {} is no longer coerced to "[object Object]"', async () => {
      await expect(
        body(CreateServiceDto, service({ name: {} })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('booleans require JSON booleans', () => {
    it.each(['true', 'false', 1, 0, 'yes'])('rejects isActive %p', async (isActive) => {
      await expect(
        body(CreateProviderWorkingHourDto, workingHour({ isActive })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([true, false])('accepts isActive %p', async (isActive) => {
      await expect(
        body(CreateProviderWorkingHourDto, workingHour({ isActive })),
      ).resolves.toMatchObject({ isActive });
    });

    it('keeps isActive optional on create (omitted)', async () => {
      const result = await body(CreateProviderWorkingHourDto, workingHour());

      expect(result.isActive).toBeUndefined();
    });

    it('still rejects explicit null on PATCH (existing ValidateIf rule)', async () => {
      await expect(
        body(UpdateProviderWorkingHourDto, { isActive: null }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('strings reject non-string JSON types', () => {
    it.each([['array', ['Bath']], ['number', 42], ['boolean', true]])(
      'rejects name as %s',
      async (_label, name) => {
        await expect(
          body(CreateServiceDto, service({ name })),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it('rejects a numeric phone (string contract; would drop leading zero)', async () => {
      await expect(
        body(RegisterDto, {
          fullName: 'An',
          email: 'an@example.com',
          password: 'Password1',
          phone: 901234567,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('keeps trimming valid strings', async () => {
      await expect(
        body(CreateServiceDto, service({ name: '  Bath  ' })),
      ).resolves.toMatchObject({ name: 'Bath' });
    });
  });

  describe('numbers', () => {
    it.each([
      ['boolean', true],
      ['empty string', ''],
      ['whitespace', ' '],
      ['array', [5]],
      ['exponent string', '1e3'],
    ])('rejects price as %s', async (_label, price) => {
      await expect(
        body(CreateServiceDto, service({ price })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects durationMinutes true (was coerced to 1)', async () => {
      await expect(
        body(CreateServiceDto, service({ durationMinutes: true })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts JSON numbers and preserves decimal precision rules', async () => {
      await expect(
        body(CreateServiceDto, service({ price: 150000.5 })),
      ).resolves.toMatchObject({ price: 150000.5 });
      await expect(
        body(CreateServiceDto, service({ price: 1.234 })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('keeps accepting canonical numeric strings for compatibility', async () => {
      await expect(body(CreateReviewDto, { rating: '5' })).resolves.toMatchObject({
        rating: 5,
      });
      await expect(
        body(CreateAvailabilitySlotDto, {
          serviceId: '1',
          slotDate: '2027-01-10',
          startTime: '09:00',
          endTime: '10:00',
          capacity: '3',
        }),
      ).resolves.toMatchObject({ capacity: 3 });
    });

    it('preserves min/max constraints after conversion', async () => {
      await expect(body(CreateReviewDto, { rating: 6 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(body(CreateReviewDto, { rating: '0' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('keeps optional nullable weight semantics on PATCH', async () => {
      await expect(body(UpdatePetDto, { weight: null })).resolves.toMatchObject({
        weight: null,
      });
      await expect(body(UpdatePetDto, { weight: '' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('treats an omitted optional number as absent', async () => {
      const result = await body(UpdateServiceDto, { name: 'Bath' });

      expect(result.price).toBeUndefined();
    });
  });

  describe('BIGINT ids', () => {
    it('normalizes JSON-number ids to strings (compatibility)', async () => {
      await expect(
        body(CreateBookingDto, { petId: 5, slotId: 7 }),
      ).resolves.toMatchObject({ petId: '5', slotId: '7' });
    });

    it('inherits id normalization through PartialType (UpdatePetDto)', async () => {
      await expect(body(UpdatePetDto, { petTypeId: 3 })).resolves.toMatchObject({
        petTypeId: '3',
      });
    });

    it.each([
      ['fraction', 1.5],
      ['zero', 0],
      ['boolean', true],
      ['unsafe integer', Number.MAX_SAFE_INTEGER + 2],
      ['empty string', ''],
    ])('rejects a %s id', async (_label, petTypeId) => {
      await expect(
        body(CreatePetDto, { petTypeId, name: 'Milo' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('query parameters', () => {
    it('converts numeric query strings', async () => {
      await expect(
        query(AdminActivityLogQueryDto, { limit: '10', offset: '20' }),
      ).resolves.toMatchObject({ limit: 10, offset: 20 });
    });

    it('applies defaults when pagination is omitted', async () => {
      await expect(query(AdminActivityLogQueryDto, {})).resolves.toMatchObject({
        limit: 50,
        offset: 0,
      });
    });

    it.each([
      ['empty offset (was coerced to 0)', { offset: '' }],
      ['non-numeric limit', { limit: 'abc' }],
      ['fractional limit', { limit: '1.5' }],
      ['repeated limit', { limit: ['1', '2'] }],
      ['limit above max', { limit: '101' }],
    ])('rejects %s', async (_label, value) => {
      await expect(query(AdminActivityLogQueryDto, value)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('keeps string filters working', async () => {
      await expect(
        query(AdminActivityLogQueryDto, { targetId: '12', targetType: 'USER' }),
      ).resolves.toMatchObject({ targetId: '12', targetType: 'USER' });
    });
  });

  describe('other existing behavior is preserved', () => {
    it('still rejects unknown properties', async () => {
      await expect(
        body(CreateReviewDto, { rating: 5, isVisible: false }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('still allows explicit null on nullable description', async () => {
      await expect(
        body(UpdateAdminServiceCategoryDto, { description: null }),
      ).resolves.toMatchObject({ description: null });
    });
  });
});
