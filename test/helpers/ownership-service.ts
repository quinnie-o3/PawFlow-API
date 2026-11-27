import type { DataSource } from 'typeorm';

import { OwnershipService } from '../../src/auth/authorization/ownership.service';
import { ProviderStaff } from '../../src/providers/entities/provider-staff.entity';
import { Provider } from '../../src/providers/entities/provider.entity';

type FindOne = (options: unknown) => Promise<unknown>;

/**
 * A real OwnershipService over a fake DataSource, so unit tests of
 * provider-scoped services exercise the shared provider-resolution rule
 * instead of stubbing it away. Only the `Provider` / `ProviderStaff`
 * repositories' `findOne` are needed; omitted ones resolve to "not found".
 */
export function createOwnershipService(
  repositories: { provider?: { findOne: FindOne }; staff?: { findOne: FindOne } } = {},
): OwnershipService {
  const missing = { findOne: () => Promise.resolve(null) };
  const getRepository = (entity: unknown) => {
    if (entity === Provider) return repositories.provider ?? missing;
    if (entity === ProviderStaff) return repositories.staff ?? missing;
    throw new Error('OwnershipService only reads Provider and ProviderStaff');
  };

  return new OwnershipService({
    manager: { getRepository },
  } as unknown as DataSource);
}
