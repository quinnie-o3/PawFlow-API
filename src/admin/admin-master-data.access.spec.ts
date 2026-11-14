import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminPetTypesController } from './admin-pet-types.controller';
import { AdminServiceCategoriesController } from './admin-service-categories.controller';

// Regression guard: adding public discovery routes must not weaken the
// ADMIN-only restrictions on master-data management.
describe.each([
  ['AdminPetTypesController', AdminPetTypesController, 'admin/pet-types'],
  [
    'AdminServiceCategoriesController',
    AdminServiceCategoriesController,
    'admin/service-categories',
  ],
] as const)('%s access', (_name, controller, path) => {
  it(`stays mounted at /${path}`, () => {
    expect(Reflect.getMetadata(PATH_METADATA, controller)).toBe(path);
  });

  it('applies JwtAuthGuard and RolesGuard to every route', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
  });

  it('requires the ADMIN role', () => {
    expect(Reflect.getMetadata(ROLES_KEY, controller)).toEqual(['ADMIN']);
  });

  it('has no handler that overrides the class-level roles', () => {
    const handlers = Object.getOwnPropertyNames(controller.prototype).filter(
      (name) => name !== 'constructor',
    );

    for (const handler of handlers) {
      const method = (controller.prototype as unknown as Record<string, object>)[
        handler
      ];

      expect(Reflect.getMetadata(ROLES_KEY, method)).toBeUndefined();
      expect(Reflect.getMetadata(GUARDS_METADATA, method)).toBeUndefined();
    }
  });
});
