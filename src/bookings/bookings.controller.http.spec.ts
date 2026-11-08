import {
  ConflictException,
  type INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';

import {
  activeSessionRepository,
  sessionIdFor,
} from '../../test/helpers/auth-session-fixture';
import {
  bookingEntityFixture,
  CUSTOMER_VIEW_OF_FIXTURE,
} from '../../test/helpers/booking-fixtures';
import { AuthSession } from '../auth/entities/auth-session.entity';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../common/pipes/validation-pipe.options';
import { IDEMPOTENCY_KEY_FORMAT_MESSAGE } from './booking-idempotency';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';

const SECRET = 'p2-07-http-spec-secret';
const KEY = '3f0c8a52-6c1e-4f5b-9a7e-2d4b8c1e9f00';
// Service results are entities; the controller answers with the P2-08B
// customer projection.
const BOOKING = bookingEntityFixture();
const BOOKING_VIEW = CUSTOMER_VIEW_OF_FIXTURE;
const USERS: Record<string, { id: string; role: string; status: string }> = {
  '20': { id: '20', role: 'CUSTOMER', status: 'ACTIVE' },
  '30': { id: '30', role: 'PROVIDER_OWNER', status: 'ACTIVE' },
  '40': { id: '40', role: 'ADMIN', status: 'ACTIVE' },
};

/**
 * HTTP contract of `POST /bookings` with the real JWT strategy, role guard
 * and global ValidationPipe; only BookingsService is replaced.
 */
describe('POST /bookings Idempotency-Key HTTP contract (P2-07)', () => {
  let app: INestApplication;
  let tokens: Record<string, string>;
  const service = {
    createBooking: jest.fn(),
    createBookingIdempotently: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret: SECRET }),
      ],
      controllers: [BookingsController],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: { getOrThrow: () => SECRET } },
        {
          provide: getRepositoryToken(AuthSession),
          useValue: activeSessionRepository(USERS),
        },
        { provide: BookingsService, useValue: service },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS));
    await app.init();

    const jwt = moduleRef.get(JwtService);
    tokens = Object.fromEntries(
      Object.values(USERS).map((user) => [
        user.role,
        jwt.sign({ sub: user.id, role: user.role, sid: sessionIdFor(user.id) }),
      ]),
    );
  });

  afterAll(() => app.close());

  beforeEach(() => {
    service.createBooking.mockReset().mockResolvedValue(BOOKING);
    service.createBookingIdempotently
      .mockReset()
      .mockResolvedValue({ booking: BOOKING, replayed: false });
  });

  const post = (token?: string, key?: string, body: object = { petId: 8, slotId: '12' }) => {
    const req = request(app.getHttpServer()).post('/bookings');

    if (token) {
      req.set('Authorization', `Bearer ${token}`);
    }

    if (key !== undefined) {
      req.set('Idempotency-Key', key);
    }

    return req.send(body);
  };

  it('keeps the legacy path when the header is absent', async () => {
    const res = await post(tokens.CUSTOMER);

    expect(res.status).toBe(201);
    expect(res.body).toEqual(BOOKING_VIEW);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(service.createBooking).toHaveBeenCalledWith('20', { petId: '8', slotId: '12' });
    expect(service.createBookingIdempotently).not.toHaveBeenCalled();
  });

  it('passes the key and normalized payload to the idempotent path', async () => {
    const res = await post(tokens.CUSTOMER, KEY);

    expect(res.status).toBe(201);
    expect(res.body).toEqual(BOOKING_VIEW);
    expect(res.headers['idempotent-replayed']).toBe('false');
    expect(service.createBookingIdempotently).toHaveBeenCalledWith(
      '20',
      { petId: '8', slotId: '12' },
      KEY,
    );
    expect(service.createBooking).not.toHaveBeenCalled();
  });

  it('answers a replay with the same 201 body and Idempotent-Replayed: true', async () => {
    service.createBookingIdempotently.mockResolvedValue({ booking: BOOKING, replayed: true });

    const res = await post(tokens.CUSTOMER, KEY);

    expect(res.status).toBe(201);
    expect(res.body).toEqual(BOOKING_VIEW);
    expect(res.headers['idempotent-replayed']).toBe('true');
  });

  it.each([
    ['too short', 'short-key'],
    ['oversized (129)', 'k'.repeat(129)],
    ['oversized (8 KB)', 'k'.repeat(8192)],
    ['invalid characters', 'booking attempt #0001'],
    ['empty', ''],
  ])('rejects a %s key with 400 before booking', async (_label, key) => {
    const res = await post(tokens.CUSTOMER, key);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(IDEMPOTENCY_KEY_FORMAT_MESSAGE);
    expect(service.createBookingIdempotently).not.toHaveBeenCalled();
    expect(service.createBooking).not.toHaveBeenCalled();
  });

  it('still validates the body with a valid key', async () => {
    const res = await post(tokens.CUSTOMER, KEY, { petId: 'abc', slotId: '12' });

    expect(res.status).toBe(400);
    expect(service.createBookingIdempotently).not.toHaveBeenCalled();
  });

  it('answers 401 without a token, whatever the key', async () => {
    expect((await post(undefined, KEY)).status).toBe(401);
    expect((await post(undefined, 'bad')).status).toBe(401);
    expect(service.createBookingIdempotently).not.toHaveBeenCalled();
  });

  it.each(['PROVIDER_OWNER', 'ADMIN'])('answers 403 for %s, whatever the key', async (role) => {
    expect((await post(tokens[role], KEY)).status).toBe(403);
    expect((await post(tokens[role], 'bad')).status).toBe(403);
    expect(service.createBookingIdempotently).not.toHaveBeenCalled();
  });

  it.each([
    ['409 for a reused key with a different payload', new ConflictException('This Idempotency-Key was already used for a different booking request'), 409],
    ['409 for a full slot', new ConflictException('Availability slot is full'), 409],
    ['404 for a missing pet', new NotFoundException('Active pet belonging to the customer was not found'), 404],
  ])('propagates %s', async (_label, error, status) => {
    service.createBookingIdempotently.mockRejectedValue(error);

    const res = await post(tokens.CUSTOMER, KEY);

    expect(res.status).toBe(status);
    expect(res.body.message).toBe(error.message);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
  });

  it('documents the optional header and the replay marker in Swagger', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const operation = document.paths['/bookings'].post!;

    expect(operation.parameters).toContainEqual(
      expect.objectContaining({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        schema: expect.objectContaining({ minLength: 16, maxLength: 128 }),
      }),
    );
    expect(
      (operation.responses['201'] as { headers?: object }).headers,
    ).toHaveProperty('Idempotent-Replayed');
  });
});
