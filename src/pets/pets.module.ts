import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Pet } from './entities/pet.entity';
import { PetType } from './entities/pet-type.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Pet, PetType])],
})
export class PetsModule {}
