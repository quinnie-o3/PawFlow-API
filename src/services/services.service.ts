import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Provider } from '../providers/entities/provider.entity';
import { assertProviderCanManageResources } from '../providers/provider-lifecycle.policy';
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

    assertProviderCanManageResources(provider);

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

  /**
   * Public read-only list of service categories available for selection.
   *
   * Only ACTIVE entries are returned, projected to `id`, `name` and
   * `description`. Ordering is by name with an ID tie-breaker so results
   * are deterministic.
   */
  async getActiveServiceCategories() {
    const categories = await this.serviceCategoriesRepository.find({
      select: { id: true, name: true, description: true },
      where: { status: 'ACTIVE' },
      order: { name: 'ASC', id: 'ASC' },
    });

    return categories.map((category) => ({
      id: category.id,
      name: category.name,
      description: category.description,
    }));
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

    // Scoped to the caller's provider: another provider's service is
    // indistinguishable from a missing one (C-01).
    const service =
      await this.servicesRepository.findOne({
        where: {
          id: serviceId,
          providerId: provider.id,
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

    return service;
  }

  async updateMyService(
    ownerUserId: string,
    serviceId: string,
    dto: UpdateServiceDto,
  ) {
    const provider =
      await this.getProviderByOwner(ownerUserId);

    assertProviderCanManageResources(provider);

    const service =
      await this.servicesRepository.findOne({
        where: {
          id: serviceId,
          providerId: provider.id,
        },
      });

    if (!service) {
      throw new NotFoundException(
        'Service not found',
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

    assertProviderCanManageResources(provider);

    const service =
      await this.servicesRepository.findOne({
        where: {
          id: serviceId,
          providerId: provider.id,
        },
      });

    if (!service) {
      throw new NotFoundException(
        'Service not found',
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
    .addOrderBy('service.id', 'DESC')
    .getMany()
    .then((services) =>
      services.map((service) => this.toPublicServiceResponse(service)),
    );
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

  return this.toPublicServiceResponse(service);
}

/**
 * Explicit public projection for service discovery.
 *
 * Exposes only catalogue data and the provider's public business profile
 * (business name, address, description, rating). Internal fields such as
 * `provider.ownerId`, `provider.approvalStatus`, service status and audit
 * timestamps are omitted, as is `provider.phone`: Phase 1 has no policy
 * permitting public contact-number disclosure (same as public availability).
 */
private toPublicServiceResponse(service: Service) {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    price: service.price,
    durationMinutes: service.durationMinutes,
    category: {
      id: service.category.id,
      name: service.category.name,
      description: service.category.description,
    },
    provider: {
      id: service.provider.id,
      businessName: service.provider.businessName,
      address: service.provider.address,
      description: service.provider.description,
      ratingAvg: service.provider.ratingAvg,
      ratingCount: service.provider.ratingCount,
    },
  };
}
}