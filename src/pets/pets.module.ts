import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PetType } from './entities/pet-type.entity';
import { Pet } from './entities/pet.entity';

@Module({
  imports: [TypeOrmModule.forFeature([PetType, Pet])],
})
export class PetsModule {}