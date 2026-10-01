import { User } from '../../providers/entities/user.entity';

export interface AuthenticatedUser {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: User['role'];
  status: User['status'];
  createdAt: Date;
  updatedAt: Date;
}
