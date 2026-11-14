import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { Provider } from '../providers/entities/provider.entity';
import { Review } from '../reviews/entities/review.entity';
import { Service } from '../services/entities/service.entity';
import { User } from '../users/entities/user.entity';

@Injectable()
export class AdminStatisticsService {
  constructor(private readonly dataSource: DataSource) {}

  async getStatistics() {
    const [providers, customers, bookings, services, ratings] = await Promise.all([
      this.dataSource.getRepository(Provider).count(),
      this.dataSource.getRepository(User).count({
        where: { role: 'CUSTOMER' },
      }),
      this.dataSource.getRepository(Booking).count(),
      this.dataSource.getRepository(Service).count(),
      this.dataSource.getRepository(Review).count(),
    ]);

    return {
      providers: { total: providers },
      customers: { total: customers },
      bookings: { total: bookings },
      services: { total: services },
      ratings: { total: ratings },
    };
  }
}
