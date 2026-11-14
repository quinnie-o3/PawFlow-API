import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';
import { Complaint } from '../complaints/entities/complaint.entity';
import { Provider } from '../providers/entities/provider.entity';
import { Review } from '../reviews/entities/review.entity';
import {
  type AdminActivityAction,
} from './admin-activity-log.constants';
import { AdminActivityLogService } from './admin-activity-log.service';
import { AdminComplaintActionDto } from './dto/admin-complaint-action.dto';
import { AdminComplaintQueryDto, ComplaintStatus } from './dto/admin-complaint-query.dto';
import {
  AdminProviderQueryDto,
  ProviderApprovalStatus,
} from './dto/admin-provider-query.dto';

type ProviderAdminResponse = {
  id: string;
  businessName: string;
  address: string;
  phone: string | null;
  description: string | null;
  approvalStatus: ProviderApprovalStatus;
  ratingAvg: string;
  ratingCount: number;
  createdAt: Date;
  updatedAt: Date;
  owner: {
    id: string;
    fullName: string;
    email: string;
    phone: string | null;
    role: 'CUSTOMER' | 'PROVIDER_OWNER' | 'PROVIDER_STAFF' | 'ADMIN';
    status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  };
};

type ReviewAdminResponse = {
  id: string;
  bookingId: string;
  rating: number;
  comment: string | null;
  providerResponse: string | null;
  respondedAt: Date | null;
  isVisible: boolean;
  createdAt: Date;
  updatedAt: Date;
  booking: {
    id: string;
    customerId: string;
    providerId: string;
    serviceId: string;
    status: Booking['status'];
  };
};

type ComplaintAdminResponse = {
  id: string;
  bookingId: string;
  createdBy: string;
  reason: string;
  status: ComplaintStatus;
  adminNote: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class AdminService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly adminActivityLogService: AdminActivityLogService,
  ) {}

  async getProviders(query: AdminProviderQueryDto) {
    const providersRepository = this.dataSource.getRepository(Provider);
    const queryBuilder = this.createSafeProviderQuery(providersRepository);

    if (query.status) {
      queryBuilder.where('provider.approvalStatus = :status', {
        status: query.status,
      });
    }

    const providers = await queryBuilder
      .orderBy('provider.createdAt', 'DESC')
      .getMany();

    return providers.map((provider) => this.toSafeResponse(provider));
  }

  async getProviderById(providerId: string) {
    const providersRepository = this.dataSource.getRepository(Provider);
    const provider = await this.createSafeProviderQuery(providersRepository)
      .where('provider.id = :providerId', { providerId })
      .getOne();

    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    return this.toSafeResponse(provider);
  }

  approveProvider(adminUserId: string, providerId: string) {
    return this.transitionProvider(
      adminUserId,
      providerId,
      'PENDING',
      'APPROVED',
      'approve',
      'PROVIDER_APPROVED',
    );
  }

  rejectProvider(adminUserId: string, providerId: string) {
    return this.transitionProvider(
      adminUserId,
      providerId,
      'PENDING',
      'REJECTED',
      'reject',
      'PROVIDER_REJECTED',
    );
  }

  suspendProvider(adminUserId: string, providerId: string) {
    return this.transitionProvider(
      adminUserId,
      providerId,
      'APPROVED',
      'SUSPENDED',
      'suspend',
      'PROVIDER_SUSPENDED',
    );
  }

  reactivateProvider(adminUserId: string, providerId: string) {
    return this.transitionProvider(
      adminUserId,
      providerId,
      'SUSPENDED',
      'APPROVED',
      'reactivate',
      'PROVIDER_REACTIVATED',
    );
  }

  async getReviews() {
    const reviewsRepository = this.dataSource.getRepository(Review);
    const reviews = await this.createSafeReviewQuery(reviewsRepository)
      .orderBy('review.createdAt', 'DESC')
      .getMany();

    return reviews.map((review) => this.toSafeReviewResponse(review));
  }

  async getReviewById(reviewId: string) {
    const reviewsRepository = this.dataSource.getRepository(Review);
    const review = await this.createSafeReviewQuery(reviewsRepository)
      .where('review.id = :reviewId', { reviewId })
      .getOne();

    if (!review) {
      throw new NotFoundException('Review not found');
    }

    return this.toSafeReviewResponse(review);
  }

  hideReview(adminUserId: string, reviewId: string) {
    return this.updateReviewVisibility(
      adminUserId,
      reviewId,
      false,
      'REVIEW_HIDDEN',
    );
  }

  restoreReview(adminUserId: string, reviewId: string) {
    return this.updateReviewVisibility(
      adminUserId,
      reviewId,
      true,
      'REVIEW_RESTORED',
    );
  }

  async getComplaints(query: AdminComplaintQueryDto) {
    const complaintsRepository = this.dataSource.getRepository(Complaint);
    const queryBuilder = complaintsRepository
      .createQueryBuilder('complaint')
      .select([
        'complaint.id',
        'complaint.bookingId',
        'complaint.createdBy',
        'complaint.reason',
        'complaint.status',
        'complaint.adminNote',
        'complaint.resolvedBy',
        'complaint.resolvedAt',
        'complaint.createdAt',
        'complaint.updatedAt',
      ]);

    if (query.status) {
      queryBuilder.where('complaint.status = :status', {
        status: query.status,
      });
    }

    const complaints = await queryBuilder
      .orderBy('complaint.createdAt', 'DESC')
      .getMany();

    return complaints.map((complaint) =>
      this.toSafeComplaintResponse(complaint),
    );
  }

  async getComplaintById(complaintId: string) {
    const complaintsRepository = this.dataSource.getRepository(Complaint);
    const complaint = await complaintsRepository
      .createQueryBuilder('complaint')
      .select([
        'complaint.id',
        'complaint.bookingId',
        'complaint.createdBy',
        'complaint.reason',
        'complaint.status',
        'complaint.adminNote',
        'complaint.resolvedBy',
        'complaint.resolvedAt',
        'complaint.createdAt',
        'complaint.updatedAt',
      ])
      .where('complaint.id = :complaintId', { complaintId })
      .getOne();

    if (!complaint) {
      throw new NotFoundException('Complaint not found');
    }

    return this.toSafeComplaintResponse(complaint);
  }

  markComplaintInReview(
    adminUserId: string,
    complaintId: string,
    dto: AdminComplaintActionDto,
  ) {
    return this.transitionComplaint(
      adminUserId,
      complaintId,
      'OPEN',
      'IN_REVIEW',
      null,
      dto,
      'COMPLAINT_MARKED_IN_REVIEW',
    );
  }

  resolveComplaint(
    adminUserId: string,
    complaintId: string,
    dto: AdminComplaintActionDto,
  ) {
    return this.transitionComplaint(
      adminUserId,
      complaintId,
      'IN_REVIEW',
      'RESOLVED',
      adminUserId,
      dto,
      'COMPLAINT_RESOLVED',
    );
  }

  rejectComplaint(
    adminUserId: string,
    complaintId: string,
    dto: AdminComplaintActionDto,
  ) {
    return this.transitionComplaint(
      adminUserId,
      complaintId,
      'IN_REVIEW',
      'REJECTED',
      adminUserId,
      dto,
      'COMPLAINT_REJECTED',
    );
  }

  private async transitionProvider(
    adminUserId: string,
    providerId: string,
    expectedStatus: ProviderApprovalStatus,
    nextStatus: ProviderApprovalStatus,
    action: string,
    activityAction: AdminActivityAction,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const providersRepository = manager.getRepository(Provider);
      const provider = await providersRepository
        .createQueryBuilder('provider')
        .setLock('pessimistic_write')
        .where('provider.id = :providerId', { providerId })
        .getOne();

      if (!provider) {
        throw new NotFoundException('Provider not found');
      }

      if (provider.approvalStatus !== expectedStatus) {
        throw new ConflictException(
          `Provider must be ${expectedStatus} to ${action}`,
        );
      }

      const fromStatus = provider.approvalStatus;
      provider.approvalStatus = nextStatus;

      await providersRepository.save(provider);
      await this.adminActivityLogService.record(manager, {
        adminUserId,
        action: activityAction,
        targetType: 'PROVIDER',
        targetId: provider.id,
        metadata: { fromStatus, toStatus: nextStatus },
      });

      const updatedProvider = await this.createSafeProviderQuery(
        providersRepository,
      )
        .where('provider.id = :providerId', { providerId })
        .getOneOrFail();

      return this.toSafeResponse(updatedProvider);
    });
  }

  private async updateReviewVisibility(
    adminUserId: string,
    reviewId: string,
    isVisible: boolean,
    activityAction: AdminActivityAction,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const reviewsRepository = manager.getRepository(Review);
      const bookingsRepository = manager.getRepository(Booking);
      const providersRepository = manager.getRepository(Provider);

      const review = await reviewsRepository
        .createQueryBuilder('review')
        .setLock('pessimistic_write')
        .where('review.id = :reviewId', { reviewId })
        .getOne();

      if (!review) {
        throw new NotFoundException('Review not found');
      }

      const booking = await bookingsRepository.findOne({
        where: { id: review.bookingId },
      });

      if (!booking) {
        throw new NotFoundException('Booking not found for review');
      }

      const provider = await providersRepository
        .createQueryBuilder('provider')
        .setLock('pessimistic_write')
        .where('provider.id = :providerId', {
          providerId: booking.providerId,
        })
        .getOne();

      if (!provider) {
        throw new NotFoundException('Provider not found for review');
      }

      if (review.isVisible === isVisible) {
        throw new ConflictException(
          isVisible ? 'Review is already visible' : 'Review is already hidden',
        );
      }

      const fromVisible = review.isVisible;
      review.isVisible = isVisible;
      await reviewsRepository.save(review);

      const ratingStats = await reviewsRepository
        .createQueryBuilder('review')
        .select('COUNT(review.id)', 'count')
        .addSelect('COALESCE(AVG(review.rating), 0)', 'average')
        .innerJoin('review.booking', 'booking')
        .where('booking.providerId = :providerId', {
          providerId: provider.id,
        })
        .andWhere('review.isVisible = :isVisible', { isVisible: true })
        .getRawOne<{ count: string; average: string }>();

      provider.ratingCount = Number(ratingStats?.count ?? 0);
      provider.ratingAvg = Number(ratingStats?.average ?? 0).toFixed(2);
      await providersRepository.save(provider);
      await this.adminActivityLogService.record(manager, {
        adminUserId,
        action: activityAction,
        targetType: 'REVIEW',
        targetId: review.id,
        metadata: {
          fromVisible,
          toVisible: isVisible,
          ratingCount: provider.ratingCount,
          ratingAvg: provider.ratingAvg,
        },
      });

      const updatedReview = await this.createSafeReviewQuery(reviewsRepository)
        .where('review.id = :reviewId', { reviewId })
        .getOneOrFail();

      return this.toSafeReviewResponse(updatedReview);
    });
  }

  private async transitionComplaint(
    adminUserId: string,
    complaintId: string,
    expectedStatus: ComplaintStatus,
    nextStatus: ComplaintStatus,
    resolvedBy: string | null,
    dto: AdminComplaintActionDto,
    activityAction: AdminActivityAction,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const complaintsRepository = manager.getRepository(Complaint);
      const complaint = await complaintsRepository
        .createQueryBuilder('complaint')
        .setLock('pessimistic_write')
        .where('complaint.id = :complaintId', { complaintId })
        .getOne();

      if (!complaint) {
        throw new NotFoundException('Complaint not found');
      }

      if (complaint.status !== expectedStatus) {
        throw new ConflictException(
          `Complaint must be ${expectedStatus} for this action`,
        );
      }

      const fromStatus = complaint.status;
      const adminNoteChanged =
        dto.adminNote !== undefined && complaint.adminNote !== dto.adminNote;

      complaint.status = nextStatus;

      if (dto.adminNote !== undefined) {
        complaint.adminNote = dto.adminNote;
      }

      if (resolvedBy === null) {
        complaint.resolvedBy = null;
        complaint.resolvedAt = null;
      } else {
        complaint.resolvedBy = resolvedBy;
        complaint.resolvedAt = new Date();
      }

      const savedComplaint = await complaintsRepository.save(complaint);
      await this.adminActivityLogService.record(manager, {
        adminUserId,
        action: activityAction,
        targetType: 'COMPLAINT',
        targetId: complaint.id,
        metadata: {
          fromStatus,
          toStatus: nextStatus,
          adminNoteChanged,
        },
      });

      return this.toSafeComplaintResponse(savedComplaint);
    });
  }

  private createSafeProviderQuery(
    providersRepository: Repository<Provider>,
  ) {
    return providersRepository
      .createQueryBuilder('provider')
      .innerJoinAndSelect('provider.owner', 'owner')
      .select([
        'provider.id',
        'provider.businessName',
        'provider.address',
        'provider.phone',
        'provider.description',
        'provider.approvalStatus',
        'provider.ratingAvg',
        'provider.ratingCount',
        'provider.createdAt',
        'provider.updatedAt',
        'owner.id',
        'owner.fullName',
        'owner.email',
        'owner.phone',
        'owner.role',
        'owner.status',
      ]);
  }

  private createSafeReviewQuery(reviewsRepository: Repository<Review>) {
    return reviewsRepository
      .createQueryBuilder('review')
      .innerJoinAndSelect('review.booking', 'booking')
      .select([
        'review.id',
        'review.bookingId',
        'review.rating',
        'review.comment',
        'review.providerResponse',
        'review.respondedAt',
        'review.isVisible',
        'review.createdAt',
        'review.updatedAt',
        'booking.id',
        'booking.customerId',
        'booking.providerId',
        'booking.serviceId',
        'booking.status',
      ]);
  }

  private toSafeResponse(provider: Provider): ProviderAdminResponse {
    return {
      id: provider.id,
      businessName: provider.businessName,
      address: provider.address,
      phone: provider.phone,
      description: provider.description,
      approvalStatus: provider.approvalStatus,
      ratingAvg: provider.ratingAvg,
      ratingCount: provider.ratingCount,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
      owner: {
        id: provider.owner.id,
        fullName: provider.owner.fullName,
        email: provider.owner.email,
        phone: provider.owner.phone,
        role: provider.owner.role,
        status: provider.owner.status,
      },
    };
  }

  private toSafeReviewResponse(review: Review): ReviewAdminResponse {
    return {
      id: review.id,
      bookingId: review.bookingId,
      rating: review.rating,
      comment: review.comment,
      providerResponse: review.providerResponse,
      respondedAt: review.respondedAt,
      isVisible: review.isVisible,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      booking: {
        id: review.booking.id,
        customerId: review.booking.customerId,
        providerId: review.booking.providerId,
        serviceId: review.booking.serviceId,
        status: review.booking.status,
      },
    };
  }

  private toSafeComplaintResponse(
    complaint: Complaint,
  ): ComplaintAdminResponse {
    return {
      id: complaint.id,
      bookingId: complaint.bookingId,
      createdBy: complaint.createdBy,
      reason: complaint.reason,
      status: complaint.status,
      adminNote: complaint.adminNote,
      resolvedBy: complaint.resolvedBy,
      resolvedAt: complaint.resolvedAt,
      createdAt: complaint.createdAt,
      updatedAt: complaint.updatedAt,
    };
  }
}
