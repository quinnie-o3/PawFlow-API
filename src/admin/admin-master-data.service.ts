import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

import { PetType } from '../pets/entities/pet-type.entity';
import { ServiceCategory } from '../services/entities/service-category.entity';
import { type AdminActivityAction } from './admin-activity-log.constants';
import { AdminActivityLogService } from './admin-activity-log.service';
import { CreateAdminPetTypeDto } from './dto/create-admin-pet-type.dto';
import { CreateAdminServiceCategoryDto } from './dto/create-admin-service-category.dto';
import { AdminMasterDataQueryDto, MasterDataStatus } from './dto/admin-master-data-query.dto';
import { UpdateAdminPetTypeDto } from './dto/update-admin-pet-type.dto';
import { UpdateAdminServiceCategoryDto } from './dto/update-admin-service-category.dto';

@Injectable()
export class AdminMasterDataService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly adminActivityLogService: AdminActivityLogService,
  ) {}

  async getServiceCategories(query: AdminMasterDataQueryDto) {
    const repository = this.dataSource.getRepository(ServiceCategory);
    const categories = await repository.find({
      where: query.status ? { status: query.status } : {},
      order: { name: 'ASC' },
    });

    return categories.map((category) => this.toServiceCategoryResponse(category));
  }

  async getServiceCategoryById(categoryId: string) {
    const category = await this.dataSource.getRepository(ServiceCategory).findOne({
      where: { id: categoryId },
    });

    if (!category) {
      throw new NotFoundException('Service category not found');
    }

    return this.toServiceCategoryResponse(category);
  }

  async createServiceCategory(
    adminUserId: string,
    dto: CreateAdminServiceCategoryDto,
  ) {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const repository = manager.getRepository(ServiceCategory);
        const category = repository.create({
          name: dto.name,
          description: dto.description ?? null,
          status: 'ACTIVE',
        });
        const savedCategory = await repository.save(category);

        await this.adminActivityLogService.record(manager, {
          adminUserId,
          action: 'SERVICE_CATEGORY_CREATED',
          targetType: 'SERVICE_CATEGORY',
          targetId: savedCategory.id,
          metadata: { initialStatus: 'ACTIVE' },
        });

        return this.toServiceCategoryResponse(savedCategory);
      });
    } catch (error) {
      this.rethrowUniqueNameConflict(error, 'Service category name already exists');
      throw error;
    }
  }

  async updateServiceCategory(
    adminUserId: string,
    categoryId: string,
    dto: UpdateAdminServiceCategoryDto,
  ) {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const repository = manager.getRepository(ServiceCategory);
        const category = await repository
          .createQueryBuilder('category')
          .setLock('pessimistic_write')
          .where('category.id = :categoryId', { categoryId })
          .getOne();

        if (!category) {
          throw new NotFoundException('Service category not found');
        }

        const changedFields: Array<'name' | 'description'> = [];

        if (dto.name !== undefined && dto.name !== category.name) {
          category.name = dto.name;
          changedFields.push('name');
        }

        if (
          dto.description !== undefined &&
          dto.description !== category.description
        ) {
          category.description = dto.description;
          changedFields.push('description');
        }

        const savedCategory = await repository.save(category);

        if (changedFields.length > 0) {
          await this.adminActivityLogService.record(manager, {
            adminUserId,
            action: 'SERVICE_CATEGORY_UPDATED',
            targetType: 'SERVICE_CATEGORY',
            targetId: savedCategory.id,
            metadata: { changedFields },
          });
        }

        return this.toServiceCategoryResponse(savedCategory);
      });
    } catch (error) {
      this.rethrowUniqueNameConflict(error, 'Service category name already exists');
      throw error;
    }
  }

  activateServiceCategory(adminUserId: string, categoryId: string) {
    return this.transitionServiceCategory(
      adminUserId,
      categoryId,
      'INACTIVE',
      'ACTIVE',
      'SERVICE_CATEGORY_ACTIVATED',
    );
  }

  deactivateServiceCategory(adminUserId: string, categoryId: string) {
    return this.transitionServiceCategory(
      adminUserId,
      categoryId,
      'ACTIVE',
      'INACTIVE',
      'SERVICE_CATEGORY_DEACTIVATED',
    );
  }

  async getPetTypes(query: AdminMasterDataQueryDto) {
    const repository = this.dataSource.getRepository(PetType);
    const petTypes = await repository.find({
      where: query.status ? { status: query.status } : {},
      order: { name: 'ASC' },
    });

    return petTypes.map((petType) => this.toPetTypeResponse(petType));
  }

  async getPetTypeById(petTypeId: string) {
    const petType = await this.dataSource.getRepository(PetType).findOne({
      where: { id: petTypeId },
    });

    if (!petType) {
      throw new NotFoundException('Pet type not found');
    }

    return this.toPetTypeResponse(petType);
  }

  async createPetType(adminUserId: string, dto: CreateAdminPetTypeDto) {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const repository = manager.getRepository(PetType);
        const petType = repository.create({
          name: dto.name,
          status: 'ACTIVE',
        });
        const savedPetType = await repository.save(petType);

        await this.adminActivityLogService.record(manager, {
          adminUserId,
          action: 'PET_TYPE_CREATED',
          targetType: 'PET_TYPE',
          targetId: savedPetType.id,
          metadata: { initialStatus: 'ACTIVE' },
        });

        return this.toPetTypeResponse(savedPetType);
      });
    } catch (error) {
      this.rethrowUniqueNameConflict(error, 'Pet type name already exists');
      throw error;
    }
  }

  async updatePetType(
    adminUserId: string,
    petTypeId: string,
    dto: UpdateAdminPetTypeDto,
  ) {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const repository = manager.getRepository(PetType);
        const petType = await repository
          .createQueryBuilder('petType')
          .setLock('pessimistic_write')
          .where('petType.id = :petTypeId', { petTypeId })
          .getOne();

        if (!petType) {
          throw new NotFoundException('Pet type not found');
        }

        const changedFields: Array<'name'> = [];

        if (dto.name !== undefined && dto.name !== petType.name) {
          petType.name = dto.name;
          changedFields.push('name');
        }

        const savedPetType = await repository.save(petType);

        if (changedFields.length > 0) {
          await this.adminActivityLogService.record(manager, {
            adminUserId,
            action: 'PET_TYPE_UPDATED',
            targetType: 'PET_TYPE',
            targetId: savedPetType.id,
            metadata: { changedFields },
          });
        }

        return this.toPetTypeResponse(savedPetType);
      });
    } catch (error) {
      this.rethrowUniqueNameConflict(error, 'Pet type name already exists');
      throw error;
    }
  }

  activatePetType(adminUserId: string, petTypeId: string) {
    return this.transitionPetType(
      adminUserId,
      petTypeId,
      'INACTIVE',
      'ACTIVE',
      'PET_TYPE_ACTIVATED',
    );
  }

  deactivatePetType(adminUserId: string, petTypeId: string) {
    return this.transitionPetType(
      adminUserId,
      petTypeId,
      'ACTIVE',
      'INACTIVE',
      'PET_TYPE_DEACTIVATED',
    );
  }

  private async transitionServiceCategory(
    adminUserId: string,
    categoryId: string,
    expectedStatus: MasterDataStatus,
    nextStatus: MasterDataStatus,
    activityAction: AdminActivityAction,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(ServiceCategory);
      const category = await repository
        .createQueryBuilder('category')
        .setLock('pessimistic_write')
        .where('category.id = :categoryId', { categoryId })
        .getOne();

      if (!category) {
        throw new NotFoundException('Service category not found');
      }

      if (category.status !== expectedStatus) {
        throw new ConflictException(
          `Service category must be ${expectedStatus} for this action`,
        );
      }

      const fromStatus = category.status;
      category.status = nextStatus;

      const savedCategory = await repository.save(category);
      await this.adminActivityLogService.record(manager, {
        adminUserId,
        action: activityAction,
        targetType: 'SERVICE_CATEGORY',
        targetId: savedCategory.id,
        metadata: { fromStatus, toStatus: nextStatus },
      });

      return this.toServiceCategoryResponse(savedCategory);
    });
  }

  private async transitionPetType(
    adminUserId: string,
    petTypeId: string,
    expectedStatus: MasterDataStatus,
    nextStatus: MasterDataStatus,
    activityAction: AdminActivityAction,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(PetType);
      const petType = await repository
        .createQueryBuilder('petType')
        .setLock('pessimistic_write')
        .where('petType.id = :petTypeId', { petTypeId })
        .getOne();

      if (!petType) {
        throw new NotFoundException('Pet type not found');
      }

      if (petType.status !== expectedStatus) {
        throw new ConflictException(
          `Pet type must be ${expectedStatus} for this action`,
        );
      }

      const fromStatus = petType.status;
      petType.status = nextStatus;

      const savedPetType = await repository.save(petType);
      await this.adminActivityLogService.record(manager, {
        adminUserId,
        action: activityAction,
        targetType: 'PET_TYPE',
        targetId: savedPetType.id,
        metadata: { fromStatus, toStatus: nextStatus },
      });

      return this.toPetTypeResponse(savedPetType);
    });
  }

  private rethrowUniqueNameConflict(error: unknown, message: string): void {
    if (error instanceof QueryFailedError) {
      const driverError = error.driverError as { code?: string };

      if (driverError.code === '23505') {
        throw new ConflictException(message);
      }
    }
  }

  private toServiceCategoryResponse(category: ServiceCategory) {
    return {
      id: category.id,
      name: category.name,
      description: category.description,
      status: category.status,
      createdAt: category.createdAt,
      updatedAt: category.updatedAt,
    };
  }

  private toPetTypeResponse(petType: PetType) {
    return {
      id: petType.id,
      name: petType.name,
      status: petType.status,
      createdAt: petType.createdAt,
      updatedAt: petType.updatedAt,
    };
  }
}
