# Database Design

## 1. Overview

The pet-care platform uses PostgreSQL as its relational database and NestJS with TypeORM as its ORM layer. The schema stores user accounts, pets, provider businesses, services, availability, bookings, payments, feedback, and complaints. It currently contains 14 core tables.

Database evolution is managed through TypeORM migrations. TypeORM is configured with `synchronize: false` so entity metadata does not automatically alter the database; executed migrations and the PostgreSQL schema are the source of truth.

## 2. Database Technology and Conventions

- **Database:** PostgreSQL.
- **Application layer:** NestJS with TypeORM.
- **Primary keys:** auto-increment `BIGINT` identifiers.
- **Naming:** database tables and columns use `snake_case`; TypeScript entity properties use `camelCase`.
- **Time values:** audit timestamps use `TIMESTAMPTZ`; date-only and time-only fields use `DATE` and `TIME` respectively.
- **Numeric values:** `NUMERIC` is used where decimal precision matters, including prices, ratings, and pet weight.
- **Integrity:** `CHECK`, `UNIQUE`, foreign-key, and index definitions are created by migrations.

## 3. Core Tables Overview

| Table | Purpose |
| --- | --- |
| `users` | User accounts, roles, account status, and credentials. |
| `pet_types` | Reference list of pet types. |
| `pets` | Pets owned by registered users. |
| `providers` | Provider business profiles owned by users. |
| `provider_staff` | User-to-provider staff assignments. |
| `provider_working_hours` | Recurring provider operating hours. |
| `service_categories` | Classification of services. |
| `services` | Services offered by providers. |
| `availability_slots` | Bookable time slots for provider services. |
| `bookings` | Customer reservations of a pet, service, provider, and slot. |
| `booking_status_logs` | Audit history of booking status changes. |
| `payments` | Payment information for bookings. |
| `reviews` | Customer reviews and optional provider responses. |
| `complaints` | Booking-related complaints and their resolution data. |

## 4. Detailed Table Specifications

### 4.1 `users`

Stores account identity and access-related data. `id` is an auto-increment `BIGINT` primary key. Important columns include `full_name`, `email`, optional `phone`, `password_hash`, `role`, and `status`.

- `uq_users_email_lower` is a unique expression index on `LOWER(email)`, enforcing case-insensitive email uniqueness.
- `chk_users_role` permits `CUSTOMER`, `PROVIDER_OWNER`, `PROVIDER_STAFF`, or `ADMIN`.
- `chk_users_status` permits `ACTIVE`, `INACTIVE`, or `SUSPENDED`.
- Referenced by pet ownership, provider ownership, staff assignments, bookings, status logs, review responses, and complaints.

### 4.2 `pet_types`

Defines the available classifications for pets. It has an auto-increment `BIGINT` primary key, a unique `name`, `status`, and timestamps.

- `chk_pet_types_status` permits `ACTIVE` or `INACTIVE`.
- Referenced by `pets.pet_type_id`.

### 4.3 `pets`

Stores a customer's pets. The primary key is `id`; `owner_id` references `users.id` and `pet_type_id` references `pet_types.id`, both with `ON DELETE RESTRICT`.

- Optional profile fields are `breed`, `birth_date`, `weight`, and `health_note`.
- `chk_pets_weight` requires a non-null `weight` to be greater than zero.
- `chk_pets_status` permits `ACTIVE` or `INACTIVE`.
- `uq_pets_id_owner` uniquely defines `(id, owner_id)` to support the booking ownership foreign key.
- `idx_pets_owner` and `idx_pets_type` support ownership and type lookups.

### 4.4 `providers`

Represents a provider business profile. `owner_id` references `users.id` with `ON DELETE RESTRICT` and is unique; therefore, the current schema permits at most one provider per owner.

- Business data includes `business_name`, `address`, optional `phone`, and optional `description`.
- `approval_status` defaults to `PENDING`; `chk_provider_approval` permits `PENDING`, `APPROVED`, `REJECTED`, or `SUSPENDED`.
- `chk_provider_rating_avg` restricts `rating_avg` to 0-5, and `chk_provider_rating_count` requires a non-negative count.
- `idx_providers_approval_status` supports approval-status filtering.

### 4.5 `provider_staff`

Associates a user with a provider as a staff member. `provider_id` references `providers.id` with `ON DELETE CASCADE`; `user_id` references `users.id` with `ON DELETE RESTRICT`.

- `user_id` is unique, so a user can belong to at most one provider-staff record.
- Optional `position` describes the staff role within the provider.
- `chk_provider_staff_status` permits `ACTIVE` or `INACTIVE`.
- `idx_provider_staff_provider` supports staff lookup by provider.

### 4.6 `provider_working_hours`

Stores recurring operating periods for providers. `provider_id` references `providers.id` with `ON DELETE CASCADE`.

- `day_of_week` is constrained to 0-6 by `chk_working_hours_day`.
- `chk_working_hours_time` requires `start_time < end_time`.
- `uq_provider_working_hours` prevents duplicate periods for the same provider, day, start time, and end time.
- `is_active` defaults to `true`; `idx_working_hours_provider` supports provider lookup.

### 4.7 `service_categories`

Contains service classifications. It uses an auto-increment `BIGINT` primary key, a unique `name`, optional `description`, `status`, and timestamps.

- `chk_service_categories_status` permits `ACTIVE` or `INACTIVE`.
- Referenced by `services.category_id`.

### 4.8 `services`

Stores services offered by providers. `provider_id` references `providers.id` and `category_id` references `service_categories.id`; both use `ON DELETE RESTRICT`.

- Important fields are `name`, `price`, `duration_minutes`, optional `description`, and `status`.
- `chk_services_price` requires `price >= 0`; `chk_services_duration` requires `duration_minutes > 0`.
- `chk_services_status` permits `ACTIVE` or `INACTIVE`.
- `uq_services_id_provider` defines `(id, provider_id)` for composite foreign keys from slots and bookings.
- Indexes cover provider, category, and status: `idx_services_provider`, `idx_services_category`, and `idx_services_status`.

### 4.9 `availability_slots`

Represents a bookable date and time interval for a provider service. `provider_id` references `providers.id`. The composite foreign key `(service_id, provider_id)` references `services(id, provider_id)`, so a slot cannot use a service from another provider. Both foreign keys use `ON DELETE RESTRICT`.

- Core fields are `slot_date`, `start_time`, `end_time`, `capacity`, `booked_count`, and `status`.
- Checks require `start_time < end_time`, `capacity > 0`, and `0 <= booked_count <= capacity`.
- `status` is limited to `OPEN`, `CLOSED`, or `CANCELLED`.
- `uq_availability_slot` uniquely identifies a provider/service/date/time interval.
- `uq_slots_booking_context` defines `(id, provider_id, service_id)` for the booking slot foreign key.
- Indexes support filtering by provider, service, date, status, and the common provider/service/date/status search context.

### 4.10 `bookings`

Stores a customer reservation. Its primary key is `id`; key columns are `customer_id`, `pet_id`, `provider_id`, `service_id`, `slot_id`, `status`, `booked_price`, and optional `customer_note`.

- `customer_id` references `users.id`.
- `(pet_id, customer_id)` references `pets(id, owner_id)`, enforcing that the booked pet belongs to the booking customer.
- `provider_id` references `providers.id`.
- `(service_id, provider_id)` references `services(id, provider_id)`, enforcing that the selected service belongs to the selected provider.
- `(slot_id, provider_id, service_id)` references `availability_slots(id, provider_id, service_id)`, enforcing that the selected slot matches the selected provider and service.
- All booking foreign keys use `ON DELETE RESTRICT`.
- `chk_bookings_status` permits `PENDING_CONFIRMATION`, `CONFIRMED`, `REJECTED`, `COMPLETED`, `CANCELLED`, or `NO_SHOW`; `chk_bookings_price` requires `booked_price >= 0`.
- Indexes support filtering by customer, pet, provider, service, slot, status, and the combined provider/status context.

### 4.11 `booking_status_logs`

Provides a history of booking status changes. `booking_id` references `bookings.id` with `ON DELETE CASCADE`; `changed_by` optionally references `users.id` with `ON DELETE SET NULL`.

- Stores optional `old_status`, required `new_status`, optional `reason`, and `created_at`.
- Checks restrict both status fields to the valid booking status values; `old_status` may be null.
- `idx_booking_logs_booking` and `idx_booking_logs_created_at` support history retrieval.

### 4.12 `payments`

Stores payment data for a booking. `booking_id` references `bookings.id` with `ON DELETE RESTRICT` and is unique, so the current schema allows one payment record per booking.

- `amount` must be non-negative.
- Optional `method` is limited to `CASH`, `QR`, `BANK_TRANSFER`, or `OTHER` when present.
- `payment_status` defaults to `UNPAID` and is limited to `UNPAID`, `PAID`, or `FAILED`.
- `idx_payments_status` and `idx_payments_paid_at` support payment processing queries.

### 4.13 `reviews`

Stores feedback for a booking. `booking_id` references `bookings.id` with `ON DELETE RESTRICT` and is unique, so each booking has at most one review.

- `rating` is constrained to 1-5.
- Optional fields include `comment`, `provider_response`, `responded_by`, and `responded_at`.
- `responded_by` references `users.id` with `ON DELETE SET NULL`.
- `is_visible` defaults to `true`; indexes support visibility and creation-time queries.

### 4.14 `complaints`

Stores booking-related complaints and their resolution information. `booking_id` references `bookings.id`; `created_by` references `users.id`; both use `ON DELETE RESTRICT`. Optional `resolved_by` references `users.id` with `ON DELETE SET NULL`.

- Important fields are `reason`, `status`, optional `admin_note`, `resolved_at`, and timestamps.
- `chk_complaints_status` permits `OPEN`, `IN_REVIEW`, `RESOLVED`, or `REJECTED`.
- Indexes support queries by booking, status, creator, and creation time.

## 5. Relationship Summary

| Parent | Relationship | Child |
| --- | --- | --- |
| `users` | One owner to at most one provider (`owner_id` is unique) | `providers` |
| `users` | One user to many owned pets | `pets` |
| `pet_types` | One pet type to many pets | `pets` |
| `providers` | One provider to many staff records | `provider_staff` |
| `users` | One user to at most one staff record (`user_id` is unique) | `provider_staff` |
| `providers` | One provider to many working-hour periods | `provider_working_hours` |
| `providers` | One provider to many services | `services` |
| `service_categories` | One category to many services | `services` |
| `providers` and `services` | One provider/service context to many slots | `availability_slots` |
| `users`, `pets`, `providers`, `services`, and `availability_slots` | Referenced by each booking through scalar and composite keys | `bookings` |
| `bookings` | One booking to many status-log records | `booking_status_logs` |
| `bookings` | At most one payment | `payments` |
| `bookings` | At most one review | `reviews` |
| `bookings` | One booking to many complaints | `complaints` |

## 6. Business Rules Enforced by Database

PostgreSQL enforces core data-integrity rules directly:

- A customer can book only a pet they own through `(pet_id, customer_id)`.
- A booking service must belong to its selected provider through `(service_id, provider_id)`.
- A booking slot must match both the selected provider and service through `(slot_id, provider_id, service_id)`.
- Slot capacity is positive and `booked_count` cannot exceed `capacity`.
- Provider ratings, review ratings, monetary amounts, pet weights, and time intervals are range-checked.
- Status values are limited to valid values, although valid *transitions* between statuses are application-level logic rather than a database rule.
- The schema permits one provider per owner, one provider-staff membership per user, one payment per booking, and one review per booking.

These foreign-key, `CHECK`, and `UNIQUE` constraints protect integrity even when data is written outside normal application flows.

## 7. Indexing Strategy

Indexes support expected lookup and filtering workloads:

- `uq_users_email_lower` supports case-insensitive account lookup and uniqueness.
- Provider approval status and pet owner/type indexes support provider discovery and pet management.
- Service provider/category/status indexes support catalogue filtering.
- Availability-slot indexes support provider, service, date, status, and combined slot-search queries.
- Booking indexes support customer history, provider schedules, service/slot lookups, and provider/status filtering.
- Booking logs, payments, reviews, and complaints have indexes for their main operational filters, including status, time, booking, visibility, and creator.

## 8. Migration Strategy

The schema is managed by seven TypeORM migrations in `src/database/migrations`:

1. `CreateUsers`
2. `CreatePetTypesAndPets`
3. `CreateProviders`
4. `CreateServices`
5. `CreateAvailabilitySlots`
6. `CreateBookings`
7. `CreatePaymentsAndFeedback`

Migrations represent database history. Executed migrations must not be modified; future schema changes should be introduced through new migrations. TypeORM synchronization remains disabled with `synchronize: false`.

## 9. Current Design Notes

- The schema currently uses internal auto-increment `BIGINT` primary keys. Public UUID identifiers may be considered later if required, but are not part of the current design.
- Some composite unique constraints support composite foreign keys, including the booking consistency rules.
- `providers.owner_id` being unique is a current schema decision that enforces at most one provider per owner.
- `provider_staff.user_id` being unique is a current schema decision that limits a user to one provider-staff membership.

## Entity Relationship Diagram

> The ERD image can be added to `docs/images/database-erd.png`.
