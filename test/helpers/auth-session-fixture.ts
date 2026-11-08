/**
 * P3-BE01 test helper: lets HTTP specs run the real JwtStrategy, which
 * validates the token's session (`sid`) against `auth_sessions`.
 * Each user gets one deterministic, active session.
 */

/** Deterministic session id for a numeric user id. */
export function sessionIdFor(userId: string): string {
  return `00000000-0000-4000-8000-${userId.padStart(12, '0')}`;
}

/** Stand-in for the AuthSession repository used by JwtStrategy. */
export function activeSessionRepository(users: Record<string, object>) {
  return {
    findOne: ({ where }: { where: { id: string; userId: string } }) => {
      const user = users[where.userId];

      return Promise.resolve(
        user && where.id === sessionIdFor(where.userId)
          ? {
              id: where.id,
              userId: where.userId,
              revokedAt: null,
              expiresAt: new Date(Date.now() + 3_600_000),
              user,
            }
          : null,
      );
    },
  };
}
