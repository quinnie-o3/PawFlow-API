import { User } from '../../providers/entities/user.entity';

export interface JwtPayload {
  sub: string;
  email: string;
  role: User['role'];
}
