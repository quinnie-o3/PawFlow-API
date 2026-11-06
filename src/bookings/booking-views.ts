import type { BookingStatusLog } from './entities/booking-status-log.entity';
import type { Booking } from './entities/booking.entity';

/**
 * P2-08B: explicit booking response projections.
 *
 * Booking endpoints never serialize TypeORM entities. Every response is
 * built here from a whitelist, so a column added to an entity (or a
 * relation loaded for another reason) cannot leak into the API. BIGINT
 * IDs and NUMERIC amounts stay strings, dates stay ISO timestamps, and
 * slot times keep the `HH:mm:ss` column format.
 */

type BookingStatus = Booking['status'];

export interface BookingPetTypeView {
  id: string;
  name: string;
}

export interface BookingServiceView {
  id: string;
  name: string;
  /** Current service duration (not a booking-time snapshot). */
  durationMinutes: number;
}

export interface BookingSlotView {
  id: string;
  slotDate: string;
  startTime: string;
  endTime: string;
}

export interface BookingStatusLogView {
  id: string;
  oldStatus: BookingStatus | null;
  newStatus: BookingStatus;
  reason: string | null;
  createdAt: Date;
}

interface BookingViewBase {
  id: string;
  status: BookingStatus;
  /** Service price snapshot taken when the booking was created. */
  bookedPrice: string;
  customerNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  service: BookingServiceView;
  slot: BookingSlotView;
}

/** What a customer sees about their own booking. */
export interface CustomerBookingView extends BookingViewBase {
  pet: {
    id: string;
    name: string;
    breed: string | null;
    petType: BookingPetTypeView;
  };
  /** Public provider profile fields only (no owner, phone or approval data). */
  provider: {
    id: string;
    businessName: string;
    address: string;
  };
}

export interface CustomerBookingDetailView extends CustomerBookingView {
  statusLogs: BookingStatusLogView[];
}

/** What the provider owner and its active staff see to fulfil a booking. */
export interface ProviderBookingView extends BookingViewBase {
  /** Name only: no email, phone or account data. */
  customer: {
    id: string;
    fullName: string;
  };
  /** Care-relevant pet details; the owner reference is not exposed. */
  pet: {
    id: string;
    name: string;
    breed: string | null;
    birthDate: string | null;
    weight: string | null;
    healthNote: string | null;
    petType: BookingPetTypeView;
  };
}

export interface ProviderBookingDetailView extends ProviderBookingView {
  statusLogs: BookingStatusLogView[];
}

function toBaseView(booking: Booking): BookingViewBase {
  return {
    id: String(booking.id),
    status: booking.status,
    bookedPrice: booking.bookedPrice,
    customerNote: booking.customerNote,
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt,
    service: {
      id: String(booking.service.id),
      name: booking.service.name,
      durationMinutes: booking.service.durationMinutes,
    },
    slot: {
      id: String(booking.slot.id),
      slotDate: booking.slot.slotDate,
      startTime: booking.slot.startTime,
      endTime: booking.slot.endTime,
    },
  };
}

function toPetTypeView(booking: Booking): BookingPetTypeView {
  return {
    id: String(booking.pet.petType.id),
    name: booking.pet.petType.name,
  };
}

// Oldest first, as the history is read top to bottom.
function toStatusLogViews(logs: BookingStatusLog[]): BookingStatusLogView[] {
  return [...logs]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((log) => ({
      id: String(log.id),
      oldStatus: log.oldStatus,
      newStatus: log.newStatus,
      reason: log.reason,
      createdAt: log.createdAt,
    }));
}

/** Requires the `pet.petType`, `provider`, `service` and `slot` relations. */
export function toCustomerBookingView(booking: Booking): CustomerBookingView {
  return {
    ...toBaseView(booking),
    pet: {
      id: String(booking.pet.id),
      name: booking.pet.name,
      breed: booking.pet.breed,
      petType: toPetTypeView(booking),
    },
    provider: {
      id: String(booking.provider.id),
      businessName: booking.provider.businessName,
      address: booking.provider.address,
    },
  };
}

/** Also requires the `statusLogs` relation. */
export function toCustomerBookingDetailView(
  booking: Booking,
): CustomerBookingDetailView {
  return {
    ...toCustomerBookingView(booking),
    statusLogs: toStatusLogViews(booking.statusLogs),
  };
}

/** Requires the `customer` (id, fullName), `pet.petType`, `service` and `slot` relations. */
export function toProviderBookingView(booking: Booking): ProviderBookingView {
  return {
    ...toBaseView(booking),
    customer: {
      id: String(booking.customer.id),
      fullName: booking.customer.fullName,
    },
    pet: {
      id: String(booking.pet.id),
      name: booking.pet.name,
      breed: booking.pet.breed,
      birthDate: booking.pet.birthDate,
      weight: booking.pet.weight,
      healthNote: booking.pet.healthNote,
      petType: toPetTypeView(booking),
    },
  };
}

/** Also requires the `statusLogs` relation. */
export function toProviderBookingDetailView(
  booking: Booking,
): ProviderBookingDetailView {
  return {
    ...toProviderBookingView(booking),
    statusLogs: toStatusLogViews(booking.statusLogs),
  };
}
