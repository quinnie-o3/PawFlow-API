import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../../common/pipes/validation-pipe.options';
import {
  COMPLAINT_REASON_MAX_LENGTH,
  CreateComplaintDto,
} from './create-complaint.dto';

const pipe = new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);

function validate(value: unknown) {
  return pipe.transform(value, {
    type: 'body',
    metatype: CreateComplaintDto,
  }) as Promise<CreateComplaintDto>;
}

describe('CreateComplaintDto.reason (C-05)', () => {
  it('limits reason to 2000 characters', () => {
    expect(COMPLAINT_REASON_MAX_LENGTH).toBe(2000);
  });

  it.each([
    ['1 character', 'x'],
    ['2000 characters', 'x'.repeat(2000)],
    ['typical text', 'The groomer arrived two hours late.'],
  ])('accepts %s', async (_label, reason) => {
    await expect(validate({ reason })).resolves.toMatchObject({ reason });
  });

  it('rejects 2001 characters with 400', async () => {
    await expect(validate({ reason: 'x'.repeat(2001) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('measures length after trimming surrounding whitespace', async () => {
    const reason = 'x'.repeat(2000);

    await expect(validate({ reason: `  ${reason}  ` })).resolves.toMatchObject({
      reason,
    });
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   \t\n '],
    ['null', null],
    ['number', 42],
    ['boolean', true],
    ['object', { text: 'late' }],
    ['array', ['late']],
  ])('rejects %s with 400', async (_label, reason) => {
    await expect(validate({ reason })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('keeps reason required', async () => {
    await expect(validate({})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unknown properties such as status', async () => {
    await expect(
      validate({ reason: 'late', status: 'RESOLVED' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
