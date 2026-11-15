import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, ValidateBy } from 'class-validator';

import {
  REVIEW_RESPONSE_MAX_LENGTH,
  REVIEW_RESPONSE_MIN_LENGTH,
  codePointLength,
  normalizeReviewResponseText,
} from '../review-response-text';

/**
 * Body of `POST /providers/me/reviews/:reviewId/response`.
 *
 * Only `text` is accepted. Every other property, including `respondedBy`,
 * `respondedAt`, `providerId` and `userId`, is rejected with 400 by the
 * global strict ValidationPipe (`forbidNonWhitelisted`). The responder and
 * the timestamp are always taken from the authenticated user and the
 * database clock.
 */
export class CreateReviewResponseDto {
  @ApiProperty({
    example: 'Thank you for your feedback. We have added a groomer on Saturdays.',
    minLength: REVIEW_RESPONSE_MIN_LENGTH,
    maxLength: REVIEW_RESPONSE_MAX_LENGTH,
    description:
      'Response text. CRLF/CR are converted to LF and surrounding whitespace is trimmed; the result must be ' +
      `${REVIEW_RESPONSE_MIN_LENGTH}-${REVIEW_RESPONSE_MAX_LENGTH} Unicode code points and must not contain NUL.`,
  })
  @Transform(({ value }) => normalizeReviewResponseText(value))
  @IsString()
  @ValidateBy({
    name: 'reviewResponseText',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' &&
        !value.includes('\u0000') &&
        codePointLength(value) >= REVIEW_RESPONSE_MIN_LENGTH &&
        codePointLength(value) <= REVIEW_RESPONSE_MAX_LENGTH,
      defaultMessage: () =>
        `text must be ${REVIEW_RESPONSE_MIN_LENGTH}-${REVIEW_RESPONSE_MAX_LENGTH} characters after trimming and must not contain NUL characters`,
    },
  })
  text!: string;
}
