import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../../common/pipes/validation-pipe.options';
import { UpdateAdminPetTypeDto } from './update-admin-pet-type.dto';
import { UpdateAdminServiceCategoryDto } from './update-admin-service-category.dto';

// Same options as the global ValidationPipe registered in main.ts.
const validationPipe = new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);

function validate(metatype: new () => object, body: unknown) {
  return validationPipe.transform(body, { type: 'body', metatype });
}

describe.each([
  ['UpdateAdminPetTypeDto', UpdateAdminPetTypeDto, 100],
  ['UpdateAdminServiceCategoryDto', UpdateAdminServiceCategoryDto, 150],
] as const)('%s', (_name, metatype, maxLength) => {
  it('accepts an empty body (name omitted)', async () => {
    const result = (await validate(metatype, {})) as { name?: string };

    expect(result.name).toBeUndefined();
  });

  it('rejects explicit name: null with 400', async () => {
    await expect(validate(metatype, { name: null })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an empty name with 400', async () => {
    await expect(validate(metatype, { name: '' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a whitespace-only name with 400 after trimming', async () => {
    await expect(validate(metatype, { name: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a numeric name with 400 instead of coercing it (C-12)', async () => {
    await expect(validate(metatype, { name: 42 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an object name with 400 (C-12)', async () => {
    await expect(validate(metatype, { name: {} })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts and trims a valid name', async () => {
    const result = (await validate(metatype, { name: '  Dogs  ' })) as {
      name?: string;
    };

    expect(result.name).toBe('Dogs');
  });

  it('enforces the maximum name length', async () => {
    await expect(
      validate(metatype, { name: 'a'.repeat(maxLength) }),
    ).resolves.toBeDefined();
    await expect(
      validate(metatype, { name: 'a'.repeat(maxLength + 1) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unexpected properties with 400', async () => {
    await expect(
      validate(metatype, { name: 'Dogs', status: 'INACTIVE' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('UpdateAdminServiceCategoryDto description', () => {
  it('still allows description: null to clear the nullable column', async () => {
    const result = (await validate(UpdateAdminServiceCategoryDto, {
      description: null,
    })) as { description?: string | null };

    expect(result.description).toBeNull();
  });

  it('normalizes a whitespace-only description to null', async () => {
    const result = (await validate(UpdateAdminServiceCategoryDto, {
      description: '   ',
    })) as { description?: string | null };

    expect(result.description).toBeNull();
  });
});
