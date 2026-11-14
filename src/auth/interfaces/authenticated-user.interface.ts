import { User } from '../../users/entities/user.entity';

export interface AuthenticatedUser {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: User['role'];
  status: User['status'];
  /**
   * When the e-mail address was verified (P3-BE02); null = not verified.
   * Informational only: no endpoint requires a verified address.
   */
  emailVerifiedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Session of the access token used for the request (set by JwtStrategy,
   * P3-BE01). Absent on objects built outside a request.
   */
  sessionId?: string;
}
