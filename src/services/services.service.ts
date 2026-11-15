import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { AvailabilitySlot } from '../availability/entities/availability-slot.entity';
import {
  captureSchedulingClock,
  SLOT_NOT_ENDED_SQL,
} from '../availability/slot-eligibility';
import {
  buildPaginationMeta,
  type PaginatedResult,
  toContainsPattern,
  tokenizeSearchKeyword,
  toPageOffset,
} from '../common/utils/public-search.util';
import { Provider } from '../providers/entities/provider.entity';
import { assertProviderCanManageResources } from '../providers/provider-lifecycle.policy';
import { CreateServiceDto } from './dto/create-service.dto';
import {
  type PublicServiceSearchQueryDto,
  type PublicServiceSort,
} from './dto/public-service-search-query.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { ServiceCategory } from './entities/service-category.entity';
import { Service } from './entities/service.entity';

export interface PublicServiceResponse {
  id: string;
  name: string;
  description: string | null;
  price: string;
  durationMinutes: number;
  category: {
    id: string;
    name: string;
    description: string | null;
  };
  provider: {
    id: string;
    businessName: string;
    address: string;
    description: string | null;
    ratingAvg: string;
    ratingCount: number;
  };
}

/** Normalized filters echoed back so clients can sync URLs and drop stale responses. */
export interface PublicServiceSearchEcho {
  q: string | null;
  categoryId: string | null;
  providerId: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  minRating: number | null;
  location: string | null;
  sort: PublicServiceSort;
}

interface PublicServiceSearchRow {
  id: string;
  name: string;
  description: string | null;
  price: string;
  durationMinutes: number;
  categoryId: string;
  categoryName: string;
  categoryDescription: string | null;
  providerId: string;
  providerBusinessName: string;
  providerAddress: string;
  providerDescription: string | null;
  providerRatingAvg: string;
  providerRatingCount: number;
}

/**
 * Whitelisted ORDER BY clauses. Every mode ends with the unique service ID,
 * so equal sort keys never reorder between pages.
 */
const PUBLIC_SERVICE_ORDER: Record<
  PublicServiceSort,
  Array<[string, 'ASC' | 'DESC']>
> = {
  newest: [
    ['service.createdAt', 'DESC'],
    ['service.id', 'DESC'],
  ],
  name_asc: [
    ['LOWER(service.name)', 'ASC'],
    ['service.id', 'ASC'],
  ],
  name_desc: [
    ['LOWER(service.name)', 'DESC'],
    ['service.id', 'ASC'],
  ],
  price_asc: [
    ['service.price', 'ASC'],
    ['service.id', 'ASC'],
  ],
  price_desc: [
    ['service.price', 'DESC'],
    ['service.id', 'ASC'],
  ],
  rating_desc: [
    ['provider.ratingAvg', 'DESC'],
    ['provider.ratingCount', 'DESC'],
    ['service.id', 'ASC'],
  ],
};

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
    now: Date = new Date(),
  ) {
    const provider =
      await this.getProviderByOwner(ownerUserId);

    assertProviderCanManageResources(provider);

    return this.servicesRepository.manager.transaction(async (manager) => {
      const servicesRepository = manager.getRepository(Service);

      // FOR UPDATE: slot writes and booking creation hold FOR SHARE on this
      // row while they check the duration, so the booked-slot check below
      // cannot miss a concurrent booking (P2-08A).
      const service =
        await servicesRepository.findOne({
          where: {
            id: serviceId,
            providerId: provider.id,
          },
          lock: { mode: 'pessimistic_write' },
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
        if (dto.durationMinutes > service.durationMinutes) {
          await this.assertDurationFitsBookedSlots(
            manager,
            service.id,
            dto.durationMinutes,
            now,
          );
        }

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

      return servicesRepository.save(service);
    });
  }

  /**
   * P2-08A: a longer duration must still fit every slot of the service
   * that holds active (PENDING_CONFIRMATION / CONFIRMED) bookings for an
   * appointment that has not ended, so existing bookings are never left on
   * a slot shorter than their service. Slots without such bookings are not
   * modified; the shared eligibility rules stop offering them once they
   * are shorter than the service.
   */
  private async assertDurationFitsBookedSlots(
    manager: EntityManager,
    serviceId: string,
    durationMinutes: number,
    now: Date,
  ): Promise<void> {
    const clock = captureSchedulingClock(now);
    const tooShortSlots = await manager
      .getRepository(AvailabilitySlot)
      .createQueryBuilder('slot')
      .where('slot.serviceId = :serviceId', { serviceId })
      .andWhere(SLOT_NOT_ENDED_SQL, {
        today: clock.today,
        currentTime: clock.timeOfDay,
      })
      .andWhere(
        'EXTRACT(EPOCH FROM (slot.endTime - slot.startTime)) < :durationSeconds',
        { durationSeconds: durationMinutes * 60 },
      )
      .andWhere(
        'EXISTS (SELECT 1 FROM bookings booking WHERE booking.slot_id = slot.id AND booking.status IN (:...activeStatuses))',
        { activeStatuses: ['PENDING_CONFIRMATION', 'CONFIRMED'] },
      )
      .getCount();

    if (tooShortSlots > 0) {
      throw new ConflictException(
        `durationMinutes cannot exceed the length of ${tooShortSlots} upcoming slot(s) that already have active bookings`,
      );
    }
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
   * Public, paginated service discovery (`GET /services/public/search`).
   *
   * Visibility is identical to `getPublicServices`: ACTIVE service, APPROVED
   * provider, ACTIVE category. Filters only narrow that set, so neither the
   * items nor `totalItems` can reveal unpublished rows. Every user value is
   * bound as a parameter; sort keys come from a fixed whitelist.
   */
  async searchPublicServices(
    query: PublicServiceSearchQueryDto,
  ): Promise<PaginatedResult<PublicServiceResponse, PublicServiceSearchEcho>> {
    const builder = this.servicesRepository
      .createQueryBuilder('service')
      .innerJoin('service.provider', 'provider')
      .innerJoin('service.category', 'category')
      .where('service.status = :serviceStatus', {
        serviceStatus: 'ACTIVE',
      })
      .andWhere('provider.approvalStatus = :approvalStatus', {
        approvalStatus: 'APPROVED',
      })
      .andWhere('category.status = :categoryStatus', {
        categoryStatus: 'ACTIVE',
      });

    tokenizeSearchKeyword(query.q).forEach((term, index) => {
      const param = `keyword${index}`;

      builder.andWhere(
        `(service.name ILIKE :${param} OR service.description ILIKE :${param} OR category.name ILIKE :${param} OR provider.businessName ILIKE :${param})`,
        { [param]: toContainsPattern(term) },
      );
    });

    if (query.categoryId !== undefined) {
      builder.andWhere('service.categoryId = :categoryId', {
        categoryId: query.categoryId,
      });
    }

    if (query.providerId !== undefined) {
      builder.andWhere('service.providerId = :providerId', {
        providerId: query.providerId,
      });
    }

    if (query.minPrice !== undefined) {
      builder.andWhere('service.price >= :minPrice', {
        minPrice: query.minPrice,
      });
    }

    if (query.maxPrice !== undefined) {
      builder.andWhere('service.price <= :maxPrice', {
        maxPrice: query.maxPrice,
      });
    }

    if (query.minRating !== undefined) {
      builder.andWhere('provider.ratingAvg >= :minRating', {
        minRating: query.minRating,
      });
    }

    if (query.location !== undefined) {
      builder.andWhere('provider.address ILIKE :location', {
        location: toContainsPattern(query.location),
      });
    }

    const pageBuilder = builder
      .clone()
      .select('service.id', 'id')
      .addSelect('service.name', 'name')
      .addSelect('service.description', 'description')
      .addSelect('service.price', 'price')
      .addSelect('service.durationMinutes', 'durationMinutes')
      .addSelect('category.id', 'categoryId')
      .addSelect('category.name', 'categoryName')
      .addSelect('category.description', 'categoryDescription')
      .addSelect('provider.id', 'providerId')
      .addSelect('provider.businessName', 'providerBusinessName')
      .addSelect('provider.address', 'providerAddress')
      .addSelect('provider.description', 'providerDescription')
      .addSelect('provider.ratingAvg', 'providerRatingAvg')
      .addSelect('provider.ratingCount', 'providerRatingCount')
      .offset(toPageOffset(query.page, query.limit))
      .limit(query.limit);

    PUBLIC_SERVICE_ORDER[query.sort].forEach(([expression, direction], index) => {
      if (index === 0) {
        pageBuilder.orderBy(expression, direction);
      } else {
        pageBuilder.addOrderBy(expression, direction);
      }
    });

    const [totalItems, rows] = await Promise.all([
      builder.getCount(),
      pageBuilder.getRawMany<PublicServiceSearchRow>(),
    ]);

    return {
      items: rows.map((row) => ({
        id: String(row.id),
        name: row.name,
        description: row.description,
        price: row.price,
        durationMinutes: Number(row.durationMinutes),
        category: {
          id: String(row.categoryId),
          name: row.categoryName,
          description: row.categoryDescription,
        },
        provider: {
          id: String(row.providerId),
          businessName: row.providerBusinessName,
          address: row.providerAddress,
          description: row.providerDescription,
          ratingAvg: row.providerRatingAvg,
          ratingCount: Number(row.providerRatingCount),
        },
      })),
      meta: buildPaginationMeta(query.page, query.limit, totalItems),
      query: {
        q: query.q ?? null,
        categoryId: query.categoryId ?? null,
        providerId: query.providerId ?? null,
        minPrice: query.minPrice ?? null,
        maxPrice: query.maxPrice ?? null,
        minRating: query.minRating ?? null,
        location: query.location ?? null,
        sort: query.sort,
      },
    };
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
private toPublicServiceResponse(service: Service): PublicServiceResponse {
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