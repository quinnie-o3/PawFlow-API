import { MODULE_METADATA } from '@nestjs/common/constants';

import { AdminModule } from './admin/admin.module';
import { AppModule } from './app.module';
import { AuthModule } from './auth/auth.module';
import { AvailabilityModule } from './availability/availability.module';
import { BookingsModule } from './bookings/bookings.module';
import { ComplaintsModule } from './complaints/complaints.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { PaymentsModule } from './payments/payments.module';
import { PetsModule } from './pets/pets.module';
import { ProvidersModule } from './providers/providers.module';
import { ReviewsModule } from './reviews/reviews.module';
import { ServicesModule } from './services/services.module';
import { UsersModule } from './users/users.module';

// Regression guard: a merge once replaced AdminModule with DashboardModule,
// silently removing every /api/admin route. Both must stay registered.
describe('AppModule wiring', () => {
  const imports = Reflect.getMetadata(
    MODULE_METADATA.IMPORTS,
    AppModule,
  ) as unknown[];

  it.each([
    ['AdminModule', AdminModule],
    ['DashboardModule', DashboardModule],
    ['AuthModule', AuthModule],
    ['UsersModule', UsersModule],
    ['PetsModule', PetsModule],
    ['ProvidersModule', ProvidersModule],
    ['ServicesModule', ServicesModule],
    ['AvailabilityModule', AvailabilityModule],
    ['BookingsModule', BookingsModule],
    ['PaymentsModule', PaymentsModule],
    ['ReviewsModule', ReviewsModule],
    ['ComplaintsModule', ComplaintsModule],
  ])('registers %s', (_name, module) => {
    expect(imports).toContain(module);
  });
});
