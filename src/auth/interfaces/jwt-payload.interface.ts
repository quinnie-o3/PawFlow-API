import { User } from '../../users/entities/user.entity';

export interface JwtPayload {
  sub: string;
  email: string;
  role: User['role'];
  /** Auth session id (P3-BE01). Tokens without it are rejected. */
  sid: string;
}
