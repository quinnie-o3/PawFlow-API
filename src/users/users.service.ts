import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UpdateUserProfileDto } from './dto/update-user-profile.dto';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  async getMyProfile(userId: string) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.toProfileResponse(user);
  }

  async updateMyProfile(
    userId: string,
    updateUserProfileDto: UpdateUserProfileDto,
  ) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (updateUserProfileDto.fullName !== undefined) {
      user.fullName = updateUserProfileDto.fullName;
    }

    if (updateUserProfileDto.phone !== undefined) {
      user.phone = updateUserProfileDto.phone;
    }

    const updatedUser = await this.usersRepository.save(user);

    return this.toProfileResponse(updatedUser);
  }

  private toProfileResponse(user: User) {
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}