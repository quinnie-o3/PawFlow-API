import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OwnershipService } from '../auth/authorization/ownership.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreatePetDto } from './dto/create-pet.dto';
import { UpdatePetDto } from './dto/update-pet.dto';
import { PetType } from './entities/pet-type.entity';
import { Pet } from './entities/pet.entity';

@Injectable()
export class PetsService {
  constructor(
    @InjectRepository(Pet)
    private readonly petsRepository: Repository<Pet>,

    @InjectRepository(PetType)
    private readonly petTypesRepository: Repository<PetType>,

    private readonly ownershipService: OwnershipService,
  ) {}

  async createPet(
    user: AuthenticatedUser,
    createPetDto: CreatePetDto,
  ) {
    const petType = await this.petTypesRepository.findOne({
      where: { id: createPetDto.petTypeId, status: 'ACTIVE' },
    });

    if (!petType) {
      throw new NotFoundException('Pet type not found');
    }

    const pet = this.petsRepository.create({
      ownerId: user.id,
      petTypeId: createPetDto.petTypeId,
      name: createPetDto.name,
      breed: createPetDto.breed ?? null,
      birthDate: createPetDto.birthDate ?? null,
      weight: createPetDto.weight?.toString() ?? null,
      healthNote: createPetDto.healthNote ?? null,
      status: 'ACTIVE',
    });

    return this.petsRepository.save(pet);
  }

  async getMyPets(user: AuthenticatedUser) {
    return this.petsRepository.find({
      where: {
        ownerId: user.id,
        status: 'ACTIVE',
      },
      relations: {
        petType: true,
      },
      order: {
        createdAt: 'DESC',
      },
    });
  }

  async getMyPetById(
    user: AuthenticatedUser,
    petId: string,
  ) {
    const pet = await this.petsRepository.findOne({
      where: {
        id: petId,
        status: 'ACTIVE',
      },
      relations: {
        petType: true,
      },
    });

    if (!pet) {
      throw new NotFoundException('Pet not found');
    }

    this.ownershipService.assertCustomerOwns(
      user,
      pet.ownerId,
    );

    return pet;
  }

  async updateMyPet(
    user: AuthenticatedUser,
    petId: string,
    updatePetDto: UpdatePetDto,
  ) {
    const pet = await this.petsRepository.findOne({
      where: {
        id: petId,
        status: 'ACTIVE',
      },
    });

    if (!pet) {
      throw new NotFoundException('Pet not found');
    }

    this.ownershipService.assertCustomerOwns(
      user,
      pet.ownerId,
    );

    if (
      updatePetDto.petTypeId !== undefined &&
      updatePetDto.petTypeId !== pet.petTypeId
    ) {
      const petType = await this.petTypesRepository.findOne({
        where: { id: updatePetDto.petTypeId, status: 'ACTIVE' },
      });

      if (!petType) {
        throw new NotFoundException('Pet type not found');
      }

      pet.petTypeId = updatePetDto.petTypeId;
    }

    if (updatePetDto.name !== undefined) {
      pet.name = updatePetDto.name;
    }

    if (updatePetDto.breed !== undefined) {
      pet.breed = updatePetDto.breed;
    }

    if (updatePetDto.birthDate !== undefined) {
      pet.birthDate = updatePetDto.birthDate;
    }

    if (updatePetDto.weight !== undefined) {
      // weight may be null (clear the value); NUMERIC is mapped as string.
      pet.weight = updatePetDto.weight?.toString() ?? null;
    }

    if (updatePetDto.healthNote !== undefined) {
      pet.healthNote = updatePetDto.healthNote;
    }

    return this.petsRepository.save(pet);
  }

  async deleteMyPet(
    user: AuthenticatedUser,
    petId: string,
  ): Promise<void> {
    const pet = await this.petsRepository.findOne({
      where: {
        id: petId,
        status: 'ACTIVE',
      },
    });

    if (!pet) {
      throw new NotFoundException('Pet not found');
    }

    this.ownershipService.assertCustomerOwns(
      user,
      pet.ownerId,
    );

    pet.status = 'INACTIVE';

    await this.petsRepository.save(pet);
  }
}