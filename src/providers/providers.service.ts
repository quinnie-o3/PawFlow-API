import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { User } from '../users/entities/user.entity';
import { CreateProviderStaffDto } from './dto/create-provider-staff.dto';
import { CreateProviderDto } from './dto/create-provider.dto';
import { UpdateProviderStaffDto } from './dto/update-provider-staff.dto';
import { UpdateProviderDto } from './dto/update-provider.dto';
import { ProviderStaff } from './entities/provider-staff.entity';
import { Provider } from './entities/provider.entity';
import { CreateProviderWorkingHourDto } from './dto/create-provider-working-hour.dto';
import { UpdateProviderWorkingHourDto } from './dto/update-provider-working-hour.dto';
import { ProviderWorkingHour } from './entities/provider-working-hour.entity';

@Injectable()
export class ProvidersService {
  constructor(
    @InjectRepository(Provider)
    private readonly providersRepository: Repository<Provider>,

    @InjectRepository(ProviderStaff)
    private readonly providerStaffRepository: Repository<ProviderStaff>,

    @InjectRepository(ProviderWorkingHour)
    private readonly providerWorkingHoursRepository: Repository<ProviderWorkingHour>,

    private readonly dataSource: DataSource,
  ) {}

  async createMyProvider(
    user: AuthenticatedUser,
    createProviderDto: CreateProviderDto,
  ) {
    const existingProvider =
      await this.providersRepository.findOne({
        where: {
          ownerId: user.id,
        },
      });

    if (existingProvider) {
      throw new ConflictException(
        'Provider profile already exists for this account',
      );
    }

    try {
      return await this.dataSource.transaction(
        async (manager) => {
          const usersRepository =
            manager.getRepository(User);

          const providersRepository =
            manager.getRepository(Provider);

          const currentUser =
            await usersRepository.findOne({
              where: {
                id: user.id,
              },
            });

          if (!currentUser) {
            throw new NotFoundException(
              'User account not found',
            );
          }

          const provider =
            providersRepository.create({
              ownerId: currentUser.id,
              businessName:
                createProviderDto.businessName,
              address: createProviderDto.address,
              phone:
                createProviderDto.phone ?? null,
              description:
                createProviderDto.description ?? null,
              approvalStatus: 'PENDING',
              ratingAvg: '0',
              ratingCount: 0,
            });

          const savedProvider =
            await providersRepository.save(provider);

          currentUser.role = 'PROVIDER_OWNER';

          await usersRepository.save(currentUser);

          return savedProvider;
        },
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw new ConflictException(
          'Provider profile already exists for this account',
        );
      }

      throw error;
    }
  }

  async getMyProvider(userId: string) {
    const provider =
      await this.providersRepository.findOne({
        where: {
          ownerId: userId,
        },
      });

    if (!provider) {
      throw new NotFoundException(
        'Provider profile not found',
      );
    }

    return provider;
  }

  async updateMyProvider(
    userId: string,
    updateProviderDto: UpdateProviderDto,
  ) {
    const provider =
      await this.providersRepository.findOne({
        where: {
          ownerId: userId,
        },
      });

    if (!provider) {
      throw new NotFoundException(
        'Provider profile not found',
      );
    }

    if (
      updateProviderDto.businessName !== undefined
    ) {
      provider.businessName =
        updateProviderDto.businessName;
    }

    if (updateProviderDto.address !== undefined) {
      provider.address =
        updateProviderDto.address;
    }

    if (updateProviderDto.phone !== undefined) {
      provider.phone =
        updateProviderDto.phone ?? null;
    }

    if (
      updateProviderDto.description !== undefined
    ) {
      provider.description =
        updateProviderDto.description ?? null;
    }

    return this.providersRepository.save(provider);
  }

  async addMyStaff(
    ownerUserId: string,
    createProviderStaffDto: CreateProviderStaffDto,
  ) {
    try {
      return await this.dataSource.transaction(
        async (manager) => {
          const providersRepository =
            manager.getRepository(Provider);

          const staffRepository =
            manager.getRepository(ProviderStaff);

          const usersRepository =
            manager.getRepository(User);

          const provider =
            await providersRepository.findOne({
              where: {
                ownerId: ownerUserId,
              },
            });

          if (!provider) {
            throw new NotFoundException(
              'Provider profile not found',
            );
          }

          if (
            createProviderStaffDto.userId ===
            ownerUserId
          ) {
            throw new BadRequestException(
              'Provider owner cannot be added as provider staff',
            );
          }

          const staffUser =
            await usersRepository.findOne({
              where: {
                id: createProviderStaffDto.userId,
              },
            });

          if (!staffUser) {
            throw new NotFoundException(
              'User account not found',
            );
          }

          if (staffUser.status !== 'ACTIVE') {
            throw new BadRequestException(
              'Only active user accounts can be assigned as provider staff',
            );
          }

          if (staffUser.role !== 'CUSTOMER') {
            throw new ConflictException(
              'Only customer accounts can be assigned as provider staff',
            );
          }

          const existingStaff =
            await staffRepository.findOne({
              where: {
                userId:
                  createProviderStaffDto.userId,
              },
            });

          if (existingStaff) {
            throw new ConflictException(
              'This user is already associated with a provider',
            );
          }

          const staff = staffRepository.create({
            providerId: provider.id,
            userId: staffUser.id,
            position:
              createProviderStaffDto.position ??
              null,
            status: 'ACTIVE',
          });

          const savedStaff =
            await staffRepository.save(staff);

          staffUser.role = 'PROVIDER_STAFF';

          await usersRepository.save(staffUser);

          return savedStaff;
        },
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw new ConflictException(
          'This user is already associated with a provider',
        );
      }

      throw error;
    }
  }

  async getMyStaff(ownerUserId: string) {
    const provider =
      await this.getMyProvider(ownerUserId);

    return this.providerStaffRepository.find({
      where: {
        providerId: provider.id,
      },
      order: {
        createdAt: 'DESC',
      },
    });
  }

  async getMyStaffById(
    ownerUserId: string,
    staffId: string,
  ) {
    const provider =
      await this.getMyProvider(ownerUserId);

    const staff =
      await this.providerStaffRepository.findOne({
        where: {
          id: staffId,
        },
      });

    if (!staff) {
      throw new NotFoundException(
        'Provider staff record not found',
      );
    }

    if (staff.providerId !== provider.id) {
      throw new ForbiddenException(
        'You do not have permission to access this staff record',
      );
    }

    return staff;
  }

  async updateMyStaff(
    ownerUserId: string,
    staffId: string,
    updateProviderStaffDto: UpdateProviderStaffDto,
  ) {
    return this.dataSource.transaction(
      async (manager) => {
        const providersRepository =
          manager.getRepository(Provider);

        const staffRepository =
          manager.getRepository(ProviderStaff);

        const usersRepository =
          manager.getRepository(User);

        const provider =
          await providersRepository.findOne({
            where: {
              ownerId: ownerUserId,
            },
          });

        if (!provider) {
          throw new NotFoundException(
            'Provider profile not found',
          );
        }

        const staff =
          await staffRepository.findOne({
            where: {
              id: staffId,
            },
          });

        if (!staff) {
          throw new NotFoundException(
            'Provider staff record not found',
          );
        }

        if (staff.providerId !== provider.id) {
          throw new ForbiddenException(
            'You do not have permission to update this staff record',
          );
        }

        const staffUser =
          await usersRepository.findOne({
            where: {
              id: staff.userId,
            },
          });

        if (!staffUser) {
          throw new NotFoundException(
            'Staff user account not found',
          );
        }

        if (
          updateProviderStaffDto.position !==
          undefined
        ) {
          staff.position =
            updateProviderStaffDto.position ??
            null;
        }

        if (
          updateProviderStaffDto.status !==
          undefined
        ) {
          if (
            updateProviderStaffDto.status ===
            'ACTIVE'
          ) {
            if (staffUser.status !== 'ACTIVE') {
              throw new BadRequestException(
                'Inactive user account cannot be activated as provider staff',
              );
            }

            if (
              staffUser.role !== 'CUSTOMER' &&
              staffUser.role !==
                'PROVIDER_STAFF'
            ) {
              throw new ConflictException(
                'User account has an incompatible role',
              );
            }

            staff.status = 'ACTIVE';
            staffUser.role = 'PROVIDER_STAFF';
          }

          if (
            updateProviderStaffDto.status ===
            'INACTIVE'
          ) {
            staff.status = 'INACTIVE';

            if (
              staffUser.role ===
              'PROVIDER_STAFF'
            ) {
              staffUser.role = 'CUSTOMER';
            }
          }
        }

        const savedStaff =
          await staffRepository.save(staff);

        await usersRepository.save(staffUser);

        return savedStaff;
      },
    );
  }

  async deactivateMyStaff(
    ownerUserId: string,
    staffId: string,
  ): Promise<void> {
    await this.dataSource.transaction(
      async (manager) => {
        const providersRepository =
          manager.getRepository(Provider);

        const staffRepository =
          manager.getRepository(ProviderStaff);

        const usersRepository =
          manager.getRepository(User);

        const provider =
          await providersRepository.findOne({
            where: {
              ownerId: ownerUserId,
            },
          });

        if (!provider) {
          throw new NotFoundException(
            'Provider profile not found',
          );
        }

        const staff =
          await staffRepository.findOne({
            where: {
              id: staffId,
            },
          });

        if (!staff) {
          throw new NotFoundException(
            'Provider staff record not found',
          );
        }

        if (staff.providerId !== provider.id) {
          throw new ForbiddenException(
            'You do not have permission to deactivate this staff record',
          );
        }

        const staffUser =
          await usersRepository.findOne({
            where: {
              id: staff.userId,
            },
          });

        if (!staffUser) {
          throw new NotFoundException(
            'Staff user account not found',
          );
        }

        staff.status = 'INACTIVE';

        if (
          staffUser.role === 'PROVIDER_STAFF'
        ) {
          staffUser.role = 'CUSTOMER';
        }

        await staffRepository.save(staff);
        await usersRepository.save(staffUser);
      },
    );
  }
  async createMyWorkingHour(
  ownerUserId: string,
  dto: CreateProviderWorkingHourDto,
) {
  const provider = await this.getMyProvider(ownerUserId);

  this.assertValidWorkingHourRange(
    dto.startTime,
    dto.endTime,
  );

  try {
    const workingHour =
      this.providerWorkingHoursRepository.create({
        providerId: provider.id,
        dayOfWeek: dto.dayOfWeek,
        startTime: dto.startTime,
        endTime: dto.endTime,
        isActive: dto.isActive ?? true,
      });

    return await this.providerWorkingHoursRepository.save(
      workingHour,
    );
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    ) {
      throw new ConflictException(
        'This working-hour entry already exists',
      );
    }

    throw error;
  }
}

async getMyWorkingHours(ownerUserId: string) {
  const provider = await this.getMyProvider(ownerUserId);

  return this.providerWorkingHoursRepository.find({
    where: {
      providerId: provider.id,
    },
    order: {
      dayOfWeek: 'ASC',
      startTime: 'ASC',
    },
  });
}

async updateMyWorkingHour(
  ownerUserId: string,
  workingHourId: string,
  dto: UpdateProviderWorkingHourDto,
) {
  const provider = await this.getMyProvider(ownerUserId);

  const workingHour =
    await this.providerWorkingHoursRepository.findOne({
      where: {
        id: workingHourId,
      },
    });

  if (!workingHour) {
    throw new NotFoundException(
      'Provider working-hour record not found',
    );
  }

  if (workingHour.providerId !== provider.id) {
    throw new ForbiddenException(
      'You do not have permission to update this working-hour record',
    );
  }

  const nextDayOfWeek =
    dto.dayOfWeek ?? workingHour.dayOfWeek;

  const nextStartTime =
    dto.startTime ?? workingHour.startTime;

  const nextEndTime =
    dto.endTime ?? workingHour.endTime;

  this.assertValidWorkingHourRange(
    nextStartTime,
    nextEndTime,
  );

  workingHour.dayOfWeek = nextDayOfWeek;
  workingHour.startTime = nextStartTime;
  workingHour.endTime = nextEndTime;

  if (dto.isActive !== undefined) {
    workingHour.isActive = dto.isActive;
  }

  try {
    return await this.providerWorkingHoursRepository.save(
      workingHour,
    );
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    ) {
      throw new ConflictException(
        'This working-hour entry already exists',
      );
    }

    throw error;
  }
}

async deactivateMyWorkingHour(
  ownerUserId: string,
  workingHourId: string,
): Promise<void> {
  const provider = await this.getMyProvider(ownerUserId);

  const workingHour =
    await this.providerWorkingHoursRepository.findOne({
      where: {
        id: workingHourId,
      },
    });

  if (!workingHour) {
    throw new NotFoundException(
      'Provider working-hour record not found',
    );
  }

  if (workingHour.providerId !== provider.id) {
    throw new ForbiddenException(
      'You do not have permission to deactivate this working-hour record',
    );
  }

  workingHour.isActive = false;

  await this.providerWorkingHoursRepository.save(
    workingHour,
  );
}

private assertValidWorkingHourRange(
  startTime: string,
  endTime: string,
): void {
  if (startTime >= endTime) {
    throw new BadRequestException(
      'startTime must be earlier than endTime',
    );
  }
}
}
