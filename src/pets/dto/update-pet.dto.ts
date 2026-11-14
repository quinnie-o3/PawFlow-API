import { PartialType } from '@nestjs/swagger';

import { CreatePetDto } from './create-pet.dto';

// skipNullProperties: false -> fields may be omitted, but an explicit null
// is still validated, so non-nullable columns (name, petTypeId) reject null.
// Nullable fields keep their own @IsOptional() and can still be cleared.
export class UpdatePetDto extends PartialType(CreatePetDto, {
  skipNullProperties: false,
}) {}
