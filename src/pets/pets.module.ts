import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Pet } from '../providers/entities/pet.entity';
import { PetType } from '../providers/entities/pet-type.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Pet, PetType])],
})
export class PetsModule {}
