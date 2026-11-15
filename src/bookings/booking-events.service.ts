import { Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { CreateNotificationInput, NotificationType } from '../notifications/notification-types';
import { NotificationsService } from '../notifications/notifications.service';
import { type EnqueueResult, PushOutboxService } from '../push-delivery/push-outbox.service';
import type { Booking } from './entities/booking.entity';

export type BookingEventStatus = Booking['status'];

/** Display data of one booking, read inside the booking transaction. */
interface BookingEventDetails {
  bookingId: string;
  customerId: string;
  ownerId: string;
  /** ACTIVE staff of the booking's provider (ascending ids). */
  staffUserIds: string[];
  serviceName: string;
  petName: string;
  slotDate: string;
  startTime: string;
}

interface BookingEventRule {
  type: NotificationType;
  /** CUSTOMER: the booking's customer. PROVIDER: the provider owner + ACTIVE staff. */
  audience: 'CUSTOMER' | 'PROVIDER';
  title: string;
  body: (d: BookingEventDetails) => string;
}

const when = (d: BookingEventDetails) => `${d.slotDate} at ${d.startTime.slice(0, 5)}`;

/**
 * P3-BE06 event matrix (docs/phase3/p3-be06-event-contract.md §2): one rule
 * per status a transition can reach. Content uses service, pet, date and
 * time only; never names, contact data, price or the free-text `reason` of
 * reject / cancel / no-show.
 */
export const BOOKING_EVENT_RULES: Readonly<Record<BookingEventStatus, BookingEventRule>> = {
  PENDING_CONFIRMATION: {
    type: 'BOOKING_CREATED',
    audience: 'PROVIDER',
    title: 'New booking request',
    body: (d) => `${d.serviceName} for ${d.petName} on ${when(d)} is waiting for your confirmation.`,
  },
  CONFIRMED: {
    type: 'BOOKING_CONFIRMED',
    audience: 'CUSTOMER',
    title: 'Booking confirmed',
    body: (d) => `Your ${d.serviceName} booking for ${d.petName} on ${when(d)} was confirmed.`,
  },
  REJECTED: {
    type: 'BOOKING_REJECTED',
    audience: 'CUSTOMER',
    title: 'Booking declined',
    body: (d) => `Your ${d.serviceName} booking for ${d.petName} on ${when(d)} was declined by the provider.`,
  },
  CANCELLED: {
    type: 'BOOKING_CANCELLED',
    audience: 'PROVIDER',
    title: 'Booking cancelled',
    body: (d) => `The ${d.serviceName} booking for ${d.petName} on ${when(d)} was cancelled by the customer.`,
  },
  COMPLETED: {
    type: 'BOOKING_COMPLETED',
    audience: 'CUSTOMER',
    title: 'Booking completed',
    body: (d) => `Your ${d.serviceName} booking for ${d.petName} on ${when(d)} was completed. You can now leave a review.`,
  },
  NO_SHOW: {
    type: 'BOOKING_NO_SHOW',
    audience: 'CUSTOMER',
    title: 'Booking marked as no-show',
    body: (d) => `Your ${d.serviceName} booking for ${d.petName} on ${when(d)} was marked as a no-show.`,
  },
};

/** Deterministic per real transition: the status-log row is the event identity. */
export const bookingEventKey = (bookingId: string, statusLogId: string): string => `booking:${bookingId}:log:${statusLogId}`;

export interface BookingTransitionEvent {
  bookingId: string;
  /** Id of the booking_status_logs row this transition just inserted. */
  statusLogId: string;
  newStatus: BookingEventStatus;
  /** The user who performed the transition (never notified of their own action). */
  actorUserId: string;
}

export interface BookingEventResult {
  eventType: NotificationType;
  eventKey: string;
  /** Resolved recipients (deduplicated, actor excluded), ascending. */
  recipientUserIds: string[];
  /** One notification per recipient (new or pre-existing for this event key). */
  notificationIds: string[];
  /** Notifications created by this call (the ones passed to the outbox). */
  createdNotificationIds: string[];
  outbox: EnqueueResult;
}

const BIGINT_ID = /^[1-9]\d{0,18}$/;

/** A programming error in the caller (missing status-log id, unknown booking); aborts the booking transaction. */
export class BookingEventError extends Error {
  constructor(message: string) {
    super(`Booking event: ${message}`);
    this.name = 'BookingEventError';
  }
}

/**
 * P3-BE06-03: records the inbox notifications and push-delivery intents of
 * one booking status transition, INSIDE the caller's booking transaction
 * (the caller's EntityManager; no transaction of its own). Everything
 * commits or rolls back with the transition; any failure here throws and
 * aborts the transition.
 *
 * Recipients come only from authoritative rows (the booking's customer, or
 * its provider's owner and ACTIVE staff), never from request input; the
 * actor is excluded and the set is deduplicated.
 *
 * Idempotency: the event key is unique per (recipient, transition) through
 * uq_notifications_recipient_event; only newly created notifications are
 * enqueued, and the outbox allows one job per notification. No push
 * provider is called here: delivery is asynchronous (later subtasks).
 */
@Injectable()
export class BookingEventsService {
  private readonly logger = new Logger(BookingEventsService.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly outbox: PushOutboxService,
  ) {}

  async record(manager: EntityManager, event: BookingTransitionEvent): Promise<BookingEventResult> {
    const rule = BOOKING_EVENT_RULES[event.newStatus];
    if (!rule) throw new BookingEventError(`no rule for status ${String(event.newStatus)}`);
    if (!BIGINT_ID.test(String(event.bookingId)) || !BIGINT_ID.test(String(event.statusLogId)) || !BIGINT_ID.test(String(event.actorUserId))) {
      throw new BookingEventError('bookingId, statusLogId and actorUserId must be persisted ids');
    }

    const [d] = (await manager.query(
      `SELECT b.id::text AS "bookingId",
              b.customer_id::text AS "customerId",
              pr.owner_id::text AS "ownerId",
              ARRAY(SELECT ps.user_id::text FROM provider_staff ps
                     WHERE ps.provider_id = b.provider_id AND ps.status = 'ACTIVE'
                     ORDER BY ps.user_id) AS "staffUserIds",
              s.name AS "serviceName", p.name AS "petName",
              sl.slot_date::text AS "slotDate", sl.start_time::text AS "startTime"
         FROM bookings b
         JOIN providers pr ON pr.id = b.provider_id
         JOIN services s ON s.id = b.service_id
         JOIN pets p ON p.id = b.pet_id
         JOIN availability_slots sl ON sl.id = b.slot_id
        WHERE b.id = $1`,
      [event.bookingId],
    )) as BookingEventDetails[];
    if (!d) throw new BookingEventError(`booking ${event.bookingId} not found`);

    const audience = rule.audience === 'CUSTOMER' ? [d.customerId] : [d.ownerId, ...d.staffUserIds];
    const recipientUserIds = [...new Set(audience)]
      .filter((id) => id !== String(event.actorUserId))
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const eventKey = bookingEventKey(d.bookingId, String(event.statusLogId));

    const inputs: CreateNotificationInput[] = recipientUserIds.map((recipientUserId) => ({
      recipientUserId,
      type: rule.type,
      title: rule.title,
      body: rule.body(d).slice(0, 1000),
      payload: {
        bookingId: d.bookingId,
        status: event.newStatus,
        serviceName: d.serviceName.slice(0, 300),
        petName: d.petName.slice(0, 300),
        slotDate: d.slotDate,
        startTime: d.startTime.slice(0, 5),
      },
      target: { type: 'BOOKING', id: d.bookingId },
      eventKey,
    }));

    const results = inputs.length ? await this.notifications.createMany(inputs, manager) : [];
    const notificationIds = results.map((r) => r.notification.id);
    const createdNotificationIds = results.filter((r) => r.created).map((r) => r.notification.id);
    const outbox = await this.outbox.enqueue(manager, createdNotificationIds);

    this.logger.log(
      `Booking ${d.bookingId} -> ${event.newStatus}: ${rule.type} for ${recipientUserIds.length} recipient(s), ` +
        `${createdNotificationIds.length} new, push ${outbox.skipped ? 'skipped (disabled)' : `${outbox.enqueued.length} job(s)`}`,
    );
    return { eventType: rule.type, eventKey, recipientUserIds, notificationIds, createdNotificationIds, outbox };
  }
}
