import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Provider } from '../providers/entities/provider.entity';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { ServiceCategory } from './entities/service-category.entity';
import { Service } from './entities/service.entity';

@Injectable()
export class ServicesService {
  constructor(
    @InjectRepository(Service)
    private readonly servicesRepository: Repository<Service>,

    @InjectRepository(ServiceCategory)
    private readonly serviceCategoriesRepository: Repository<ServiceCategory>,

    @InjectRepository(Provider)
    private readonly providersRepository: Repository<Provider>,
  ) {}

  async createMyService(
    ownerUserId: string,
    dto: CreateServiceDto,
  ) {
    const provider =
      await this.getProviderByOwner(ownerUserId);

    await this.assertActiveCategory(dto.categoryId);

    const service = this.servicesRepository.create({
      providerId: provider.id,
      categoryId: dto.categoryId,
      name: dto.name,
      price: dto.price.toFixed(2),
      durationMinutes: dto.durationMinutes,
      description: dto.description ?? null,
      status: 'ACTIVE',
    });

    return this.servicesRepository.save(service);
  }

  async getMyServices(ownerUserId: string) {
    const provider =
      await this.getProviderByOwner(ownerUserId);

    return this.servicesRepository.find({
      where: {
        providerId: provider.id,
      },
      relations: {
        category: true,
      },
      order: {
        createdAt: 'DESC',
      },
    });
  }

  async getMyServiceById(
    ownerUserId: string,
    serviceId: string,
  ) {
    const provider =
      await this.getProviderByOwner(ownerUserId);

    const service =
      await this.servicesRepository.findOne({
        where: {
          id: serviceId,
        },
        relations: {
          category: true,
        },
      });

    if (!service) {
      throw new NotFoundException(
        'Service not found',
      );
    }

    if (service.providerId !== provider.id) {
      throw new ForbiddenException(
        'You do not have permission to access this service',
      );
    }

    return service;
  }

  async updateMyService(
    ownerUserId: string,
    serviceId: string,
    dto: UpdateServiceDto,
  ) {
    const provider =
      await this.getProviderByOwner(ownerUserId);

    const service =
      await this.servicesRepository.findOne({
        where: {
          id: serviceId,
        },
      });

    if (!service) {
      throw new NotFoundException(
        'Service not found',
      );
    }

    if (service.providerId !== provider.id) {
      throw new ForbiddenException(
        'You do not have permission to update this service',
      );
    }

    if (dto.categoryId !== undefined) {
      await this.assertActiveCategory(
        dto.categoryId,
      );

      service.categoryId = dto.categoryId;
    }

    if (dto.name !== undefined) {
      service.name = dto.name;
    }

    if (dto.price !== undefined) {
      service.price = dto.price.toFixed(2);
    }

    if (dto.durationMinutes !== undefined) {
      service.durationMinutes =
        dto.durationMinutes;
    }

    if (dto.description !== undefined) {
      service.description =
        dto.description ?? null;
    }

    if (dto.status !== undefined) {
      service.status = dto.status;
    }

    return this.servicesRepository.save(service);
  }

  async deactivateMyService(
    ownerUserId: string,
    serviceId: string,
  ): Promise<void> {
    const provider =
      await this.getProviderByOwner(ownerUserId);

    const service =
      await this.servicesRepository.findOne({
        where: {
          id: serviceId,
        },
      });

    if (!service) {
      throw new NotFoundException(
        'Service not found',
      );
    }

    if (service.providerId !== provider.id) {
      throw new ForbiddenException(
        'You do not have permission to deactivate this service',
      );
    }

    service.status = 'INACTIVE';

    await this.servicesRepository.save(service);
  }

  private async getProviderByOwner(
    ownerUserId: string,
  ): Promise<Provider> {
    const provider =
      await this.providersRepository.findOne({
        where: {
          ownerId: ownerUserId,
        },
      });

    if (!provider) {
      throw new NotFoundException(
        'Provider profile not found',
      );
    }

    return provider;
  }

  private async assertActiveCategory(
    categoryId: string,
  ): Promise<ServiceCategory> {
    const category =
      await this.serviceCategoriesRepository.findOne({
        where: {
          id: categoryId,
          status: 'ACTIVE',
        },
      });

    if (!category) {
      throw new NotFoundException(
        'Active service category not found',
      );
    }

    return category;
  }
  async getPublicServices() {
  return this.servicesRepository
    .createQueryBuilder('service')
    .innerJoinAndSelect('service.provider', 'provider')
    .innerJoinAndSelect('service.category', 'category')
    .where('service.status = :serviceStatus', {
      serviceStatus: 'ACTIVE',
    })
    .andWhere('provider.approvalStatus = :approvalStatus', {
      approvalStatus: 'APPROVED',
    })
    .andWhere('category.status = :categoryStatus', {
      categoryStatus: 'ACTIVE',
    })
    .orderBy('service.createdAt', 'DESC')
    .getMany();
}

async getPublicServiceById(serviceId: string) {
  const service = await this.servicesRepository
    .createQueryBuilder('service')
    .innerJoinAndSelect('service.provider', 'provider')
    .innerJoinAndSelect('service.category', 'category')
    .where('service.id = :serviceId', {
      serviceId,
    })
    .andWhere('service.status = :serviceStatus', {
      serviceStatus: 'ACTIVE',
    })
    .andWhere('provider.approvalStatus = :approvalStatus', {
      approvalStatus: 'APPROVED',
    })
    .andWhere('category.status = :categoryStatus', {
      categoryStatus: 'ACTIVE',
    })
    .getOne();

  if (!service) {
    throw new NotFoundException(
      'Public service not found',
    );
  }

  return service;
}
}