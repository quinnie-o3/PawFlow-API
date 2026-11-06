# PawFlow MVP — Frontend Integration Checklist

Companion to [mvp-fe-api-contract.md](./mvp-fe-api-contract.md) (exact endpoints, payloads and real responses).
Backend state: Phase 2 complete through P2-11B; verified by `npm run qa:fe-smoke` (31/31) and `npm run qa:mvp-e2e` (110/110).

## 1. Local setup

### Backend

1. Prerequisites: Node.js 22, PostgreSQL 15 on `localhost:5432`.
2. `npm install`, then copy `.env.example` to `.env` and fill in `DB_PASSWORD` and a long random `JWT_SECRET`.

   | Variable | Value for local FE work |
   |---|---|
   | `PORT` | `8000` (the FE `.env.example` uses `http://localhost:8000/api`) |
   | `FRONTEND_URL` | `http://localhost:3000` (Next.js dev server). This single origin is the only one allowed by CORS. |
   | `DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` / `DB_DATABASE` | your PostgreSQL; `pet_care_db` for development |
   | `JWT_SECRET` | any long random string (never commit it) |
   | `JWT_EXPIRES_IN_SECONDS` | `86400` (token lifetime in seconds). The older `JWT_EXPIRES_IN=1d` key is **not read** by the code. |
   | `TZ` | `Asia/Ho_Chi_Minh` (recommended). Slot dates/times and "already started" checks use the server's local time zone; it must be Vietnam time. |

3. Database schema: `npm run typeorm -- migration:show -d database/data-source.ts` must list **9** `[X]` migrations; apply missing ones with `migration:run` (never `synchronize`).
4. `npm run build && npm run start:prod` (or `npm run start:dev`). The API is at `http://localhost:8000/api`, Swagger at `http://localhost:8000/api/docs`.

### Frontend

`pet-care-web/.env`: `NEXT_PUBLIC_API_URL=http://localhost:8000/api`, then `npm run dev` (port 3000).

### Demo data (recommended for FE work)

The development database has almost no data (one pending provider, so public search is empty). Use the disposable demo database instead:

```bash
npm run build
QA_DEMO_SERVE=1 QA_PORTS=8000 npm run qa:demo-seed   # stop any backend already on 8000 first
```

This recreates `pawflow_qa_demo` (never `pet_care_db`), seeds it through the API and keeps the API running on port 8000 with CORS for `http://localhost:3000`. Rerun it any time to reset. Every account uses the password `PawFlow@2026`:

| Account | Role | Notes |
|---|---|---|
| `lan.customer@pawflow.test` | CUSTOMER | pets Mochi (dog) and Bơ (cat); pending, confirmed, rejected (with complaint) bookings |
| `nam.customer@pawflow.test` | CUSTOMER | pet Lu (dog); completed (reviewed, paid), cancelled, no-show bookings |
| `khoa.owner@pawflow.test` | PROVIDER_OWNER | "Paw Spa Sài Gòn" (APPROVED), 3 services, slots on the next 5 working days |
| `ha.staff@pawflow.test` | PROVIDER_STAFF | active staff of Paw Spa Sài Gòn |
| `bao.owner@pawflow.test` | PROVIDER_OWNER | "Happy Paws Thủ Đức" (APPROVED), 2 services |
| `vy.owner@pawflow.test` | PROVIDER_OWNER | "Mèo Xinh Bình Thạnh" (PENDING, hidden from public pages) |
| `admin@pawflow.test` | ADMIN | moderation and approvals |

All names, addresses and phone numbers are fictional.

## 2. Integration order

1. API client: base URL from `NEXT_PUBLIC_API_URL`, JSON, bearer header, error normalization (§4), `AbortController` support.
2. Auth: register, login, `GET /auth/me` on app start, logout = drop the token. Route by `user.role`.
3. Public discovery: provider search → provider detail (+ public reviews) → service search/detail → availability search/detail.
4. Customer: pets CRUD → booking creation with Idempotency-Key → my bookings list/detail → cancel.
5. Provider owner/staff: booking list/detail → confirm/reject/complete/no-show.
6. Owner dashboard (`from`/`to` required), simulated payments.
7. Reviews and complaints.
8. Owner self-service (services, slots, working hours, staff) — replace the remaining mocks last.

## 3. TypeScript response types

```ts
export type Id = string;            // BIGINT, always a string
export type Money = string;          // NUMERIC(…,2) as "150000.00"
export type Role = 'CUSTOMER' | 'PROVIDER_OWNER' | 'PROVIDER_STAFF' | 'ADMIN';
export type BookingStatus = 'PENDING_CONFIRMATION' | 'CONFIRMED' | 'REJECTED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';

export interface ApiError { statusCode: number; message: string | string[]; error?: string }

export interface User {
  id: Id; fullName: string; email: string; phone: string | null;
  role: Role; status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED'; createdAt: string; updatedAt: string;
}
export interface AuthResponse { accessToken: string; tokenType: 'Bearer'; user: User }   // register + login
export interface MeResponse { user: User }                                                // GET /auth/me

export interface PetType { id: Id; name: string }
export interface Pet {
  id: Id; ownerId: Id; petTypeId: Id; name: string; breed: string | null; birthDate: string | null;
  weight: string | null; healthNote: string | null; status: 'ACTIVE' | 'INACTIVE';
  createdAt: string; updatedAt: string; petType?: PetType & { status: string };
}

export interface Paginated<T, Q> {
  items: T[];
  meta: { page: number; limit: number; totalItems: number; totalPages: number; hasNextPage: boolean; hasPreviousPage: boolean };
  query: Q;
}
export interface PublicProvider {
  id: Id; businessName: string; address: string; description: string | null;
  ratingAvg: Money; ratingCount: number; serviceCount: number; minPrice: Money | null; maxPrice: Money | null;
}
export interface ServiceCategory { id: Id; name: string; description: string | null }
export interface PublicService {
  id: Id; name: string; description: string | null; price: Money; durationMinutes: number;
  category: ServiceCategory;
  provider: Pick<PublicProvider, 'id' | 'businessName' | 'address' | 'description' | 'ratingAvg' | 'ratingCount'>;
}
export interface PublicSlot {
  id: Id; slotDate: string; startTime: string; endTime: string; capacity: number; bookedCount: number;
  service: Omit<PublicService, 'provider'>;
  provider: PublicService['provider'];
}
export interface PublicReview { id: Id; rating: number; comment: string | null; providerResponse: string | null; respondedAt: string | null; createdAt: string }

interface BookingBase {
  id: Id; status: BookingStatus; bookedPrice: Money; customerNote: string | null; createdAt: string; updatedAt: string;
  service: { id: Id; name: string; durationMinutes: number };
  slot: { id: Id; slotDate: string; startTime: string; endTime: string };
}
export interface CustomerBooking extends BookingBase {
  pet: { id: Id; name: string; breed: string | null; petType: PetType };
  provider: { id: Id; businessName: string; address: string };
}
export interface ProviderBooking extends BookingBase {
  customer: { id: Id; fullName: string };
  pet: { id: Id; name: string; breed: string | null; birthDate: string | null; weight: string | null; healthNote: string | null; petType: PetType };
}
export interface BookingStatusLog { id: Id; oldStatus: BookingStatus | null; newStatus: BookingStatus; reason: string | null; createdAt: string }
export type CustomerBookingDetail = CustomerBooking & { statusLogs: BookingStatusLog[] };
export type ProviderBookingDetail = ProviderBooking & { statusLogs: BookingStatusLog[] };

export interface ProviderDashboard {
  providerId: Id; period: { from: string; to: string };
  bookingVolumeByStatus: Record<BookingStatus, number> & { total: number };
  cancellationRate: { cancelledBookings: number; resolvedBookings: number; rate: number | null };
  popularServices: { serviceId: Id; serviceName: string; completedBookings: number }[];
  returningCustomers: { count: number };
  recordedRevenue: { amount: Money };
  averageRating: { reviewCount: number; average: number | null };
  alerts: { code: string; severity: string; message: string; recommendation: string; context: Record<string, unknown> }[];
}
export interface Review { id: Id; bookingId: Id; rating: number; comment: string | null; providerResponse: string | null; respondedBy: Id | null; respondedAt: string | null; isVisible: boolean; createdAt: string; updatedAt: string }
export interface Complaint { id: Id; bookingId: Id; createdBy: Id; reason: string; status: 'OPEN' | 'IN_REVIEW' | 'RESOLVED' | 'REJECTED'; adminNote: string | null; resolvedBy: Id | null; resolvedAt: string | null; createdAt: string; updatedAt: string }
export interface Payment { id: Id; bookingId: Id; amount: Money; method: 'CASH' | 'QR' | 'BANK_TRANSFER' | 'OTHER' | null; paymentStatus: 'UNPAID' | 'PAID' | 'FAILED'; paidAt: string | null; createdAt: string; updatedAt: string }
```

## 4. Authentication and errors

- Send `Authorization: Bearer ${accessToken}` on every protected call. The existing FE login uses `credentials: "include"`; that is allowed by CORS but not needed — auth is header-based only.
- `401` anywhere → clear the token, redirect to login (tokens expire after 1 day; there is no refresh endpoint).
- `403` → "Bạn không có quyền thực hiện thao tác này" (or a lifecycle message, e.g. provider suspended).
- `404` on a detail page → "Không tìm thấy" (also used for resources that are not yours).
- `409` → show as a business conflict and refresh the affected data (slot full, status already changed…).
- `message` may be an **array**: the current `registerCustomer.ts`/`loginCustomer.ts` read it as a string, so a validation error would render as `"a,b"`. Normalize with `Array.isArray(message) ? message.join('\n') : message`.

## 5. Search UX

- Debounce keyword/location inputs (~300 ms) and cancel the previous request with `AbortController` when the query changes.
- Reflect filters in the URL; render a response only if its `query` echo matches the latest request (stale-response guard).
- Use `meta.totalPages`, `hasNextPage`, `hasPreviousPage` for pagination; `limit` ≤ 50.
- Availability search requires `providerId` or `serviceId`; pass `date` (single day) or `fromDate`/`toDate`, not both.
- A slot shown in search may be gone at booking time: handle `409`/`400` on `POST /bookings` by refreshing availability.

## 6. Booking idempotency

```ts
// one key per booking attempt
const [attemptKey, setAttemptKey] = useState<string | null>(null);
async function submit(form: { petId: string; slotId: string; customerNote?: string }) {
  const key = attemptKey ?? crypto.randomUUID();
  setAttemptKey(key);                      // reuse it for retries of this attempt
  const res = await fetch(`${API}/bookings`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(form) });
  const replayed = res.headers.get('Idempotent-Replayed') === 'true';  // readable thanks to CORS exposedHeaders
  // 201 → show the booking (replayed or not); 4xx (except network errors) → the attempt failed, keep the key only if retrying unchanged
}
// change of pet/slot/note → setAttemptKey(null) so the next submit uses a new key
```

- Disable the submit button while pending, but retries with the same key are safe even after a double click, a timeout or a page reload (persist the key with the form draft if you want reload safety).
- `201` with `Idempotent-Replayed: true` returns the original booking in its **current** status (it may already be CONFIRMED).
- `409 "…already used for a different booking request"` means the form changed but the key was not reset — generate a new key.

## 7. Loading, empty and error states

| Screen | Empty state | Errors to handle |
|---|---|---|
| Provider/service search | `items.length === 0` ("Không tìm thấy kết quả") | 400 invalid filter |
| Provider detail | — | 404 hidden/not approved |
| Availability | no bookable slots for the date | 400 missing providerId/serviceId or bad date |
| Booking | — | 400 slot started/past, 404, 409 full/outside hours/key conflict |
| My bookings | empty list | 401 |
| Provider bookings | empty list | 403 inactive staff/wrong role, 404 no provider profile |
| Dashboard | zero metrics | 400 missing/invalid `from`/`to` |

## 8. Changes compared with the current FE mocks

| Mock (pet-care-web) | Backend reality |
|---|---|
| Booking status `pendingConfirmation`, `noShow` … (camelCase) | `PENDING_CONFIRMATION`, `NO_SHOW` … (UPPER_SNAKE) — map in the client |
| `customerName`, `petName`, `petSpecies`, `serviceName` flat fields | nested `customer.fullName`, `pet.name`, `pet.petType.name`, `service.name` |
| `scheduledAt` | `slot.slotDate` + `slot.startTime`/`endTime` (local Vietnam time, no zone) |
| `price: number`, `priceSnapshot` | `bookedPrice: "150000.00"` (string snapshot) |
| `durationMinutesSnapshot` | `service.durationMinutes` (current value, not a snapshot) |
| `notes` | `customerNote` (nullable) |
| Staff mock `contactPhone`, provider-customers `email`/`phone` | **not exposed**: providers see the customer's name only (no contact policy yet) |
| `petAge`, `petWeightKg`, `petAllergies` | derive age from `pet.birthDate`; `pet.weight` is a string; `pet.healthNote` is free text |
| `providerId` on staff bookings | not returned (the caller's provider is implicit) |
| Booking `id` used with numeric logs (`BookingLog.id: number`) | all IDs are strings |
| Status history actor `{ id, name, role }` | `statusLogs` has no actor (who changed it is not exposed) |
| Service `version`, `duration: {unit}`, `active`, `completedCount`, `category: string` | `durationMinutes` number, `status` ACTIVE/INACTIVE, `categoryId`/`category` object; no version or completed count |
| Weekly schedule with `effectiveFrom`, date exceptions | recurring weekly intervals only (`dayOfWeek`, `startTime`, `endTime`, `isActive`); no exceptions/holidays |
| Slot `open: boolean` | `status: 'OPEN' | 'CLOSED' | 'CANCELLED'` (owner view) |
| Dashboard cards/alerts text | numbers + English alert text with `code`/`context`; build Vietnamese copy in the FE |
| Register response `{ message }` | `{ accessToken, tokenType, user }` (user is logged in immediately) |

## 9. Supported now vs. future work

**Supported:** registration/login/profile; pets; public provider/service/availability search with pagination; provider detail and public reviews; booking with Idempotency-Key; customer cancel; provider confirm/reject/complete/no-show (owner and active staff); provider suspension policy; owner dashboard; reviews; complaints (admin workflow); simulated offline payments (owner); owner management of services, slots, working hours and staff; admin moderation APIs.

**Not available (do not build UI that depends on them yet):**

- Notifications (email/push/in-app) — the FE `provider-notifications` mock has no backend.
- Real payment gateway, refunds; staff cannot record payments.
- Rescheduling a booking (cancel + rebook instead); automatic expiry of pending bookings.
- Pagination/filtering of booking lists (filter client-side for now).
- Provider reply to reviews (the `providerResponse` field exists but there is no endpoint).
- Contact details between customer and provider; status-change actor names.
- Schedule exceptions/holidays, overnight hours, minimum booking lead time.
- Provider resource capacity (staff assignment per slot); capacity is per slot.
- Staff dashboard (owner only).
