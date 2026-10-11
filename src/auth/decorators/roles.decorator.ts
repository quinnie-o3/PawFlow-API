import { SetMetadata } from '@nestjs/common';

import type { User } from '../../users/entities/user.entity';

export const ROLES_KEY = 'roles';

export type UserRole = User['role'];

export const Roles = (...roles: UserRole[]) =>
  SetMetadata(ROLES_KEY, roles);