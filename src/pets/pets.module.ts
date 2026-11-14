import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { PetType } from './entities/pet-type.entity';
import { Pet } from './entities/pet.entity';
import { PetTypesController } from './pet-types.controller';
import { PetsController } from './pets.controller';
import { PetsService } from './pets.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PetType,
      Pet,
    ]),
    AuthModule,
  ],
  controllers: [PetsController, PetTypesController],
  providers: [PetsService],
  exports: [PetsService],
})
export class PetsModule {}