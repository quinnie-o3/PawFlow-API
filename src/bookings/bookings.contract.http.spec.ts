import {
  ConflictException,
  type INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import {
  DocumentBuilder,
  type OpenAPIObject,
  type ResponseObject,
  type SchemaObject,
  SwaggerModule,
} from '@nestjs/swagger';
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
  forbiddenKeysIn,
  jsonKeyPaths,
  PROVIDER_VIEW_OF_FIXTURE,
  STATUS_LOGS_OF_FIXTURE,
} from '../../test/helpers/booking-fixtures';
import { AuthSession } from '../auth/entities/auth-session.entity';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../common/pipes/validation-pipe.options';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';

const SECRET = 'p2-08b-http-spec-secret';
const USERS: Record<string, { id: string; role: string; status: string }> = {
  '20': { id: '20', role: 'CUSTOMER', status: 'ACTIVE' },
  '30': { id: '30', role: 'PROVIDER_OWNER', status: 'ACTIVE' },
  '31': { id: '31', role: 'PROVIDER_STAFF', status: 'ACTIVE' },
  '40': { id: '40', role: 'ADMIN', status: 'ACTIVE' },
};
const ROLES = Object.values(USERS).map((user) => user.role);

const CUSTOMER_DETAIL = {
  ...CUSTOMER_VIEW_OF_FIXTURE,
  statusLogs: STATUS_LOGS_OF_FIXTURE,
};
const PROVIDER_DETAIL = {
  ...PROVIDER_VIEW_OF_FIXTURE,
  statusLogs: STATUS_LOGS_OF_FIXTURE,
};

interface Route {
  name: string;
  method: 'get' | 'post';
  path: string;
  swaggerPath: string;
  serviceMethod: keyof BookingsService;
  result: 'one' | 'many';
  body?: object;
  roles: string[];
  status: number;
  expected: unknown;
}

const CUSTOMER = ['CUSTOMER'];
const PROVIDER = ['PROVIDER_OWNER', 'PROVIDER_STAFF'];
const ROUTES: Route[] = [
  { name: 'create', method: 'post', path: '/bookings', swaggerPath: '/bookings', serviceMethod: 'createBooking', result: 'one', body: { petId: 8, slotId: '12' }, roles: CUSTOMER, status: 201, expected: CUSTOMER_VIEW_OF_FIXTURE },
  { name: 'customer list', method: 'get', path: '/bookings/mine', swaggerPath: '/bookings/mine', serviceMethod: 'getMyBookings', result: 'many', roles: CUSTOMER, status: 200, expected: [CUSTOMER_VIEW_OF_FIXTURE] },
  { name: 'customer detail', method: 'get', path: '/bookings/mine/100', swaggerPath: '/bookings/mine/{id}', serviceMethod: 'getMyBookingById', result: 'one', roles: CUSTOMER, status: 200, expected: CUSTOMER_DETAIL },
  { name: 'cancel', method: 'post', path: '/bookings/mine/100/cancel', swaggerPath: '/bookings/mine/{id}/cancel', serviceMethod: 'cancelMyBooking', result: 'one', body: { reason: 'Plans changed' }, roles: CUSTOMER, status: 201, expected: CUSTOMER_VIEW_OF_FIXTURE },
  { name: 'provider list', method: 'get', path: '/bookings/provider', swaggerPath: '/bookings/provider', serviceMethod: 'getProviderBookings', result: 'many', roles: PROVIDER, status: 200, expected: [PROVIDER_VIEW_OF_FIXTURE] },
  { name: 'provider detail', method: 'get', path: '/bookings/provider/100', swaggerPath: '/bookings/provider/{id}', serviceMethod: 'getProviderBookingById', result: 'one', roles: PROVIDER, status: 200, expected: PROVIDER_DETAIL },
  { name: 'confirm', method: 'post', path: '/bookings/provider/100/confirm', swaggerPath: '/bookings/provider/{id}/confirm', serviceMethod: 'confirmProviderBooking', result: 'one', roles: PROVIDER, status: 201, expected: PROVIDER_VIEW_OF_FIXTURE },
  { name: 'reject', method: 'post', path: '/bookings/provider/100/reject', swaggerPath: '/bookings/provider/{id}/reject', serviceMethod: 'rejectProviderBooking', result: 'one', body: { reason: 'Fully staffed' }, roles: PROVIDER, status: 201, expected: PROVIDER_VIEW_OF_FIXTURE },
  { name: 'complete', method: 'post', path: '/bookings/provider/100/complete', swaggerPath: '/bookings/provider/{id}/complete', serviceMethod: 'completeProviderBooking', result: 'one', roles: PROVIDER, status: 201, expected: PROVIDER_VIEW_OF_FIXTURE },
  { name: 'no-show', method: 'post', path: '/bookings/provider/100/no-show', swaggerPath: '/bookings/provider/{id}/no-show', serviceMethod: 'noShowProviderBooking', result: 'one', body: { reason: 'Did not arrive' }, roles: PROVIDER, status: 201, expected: PROVIDER_VIEW_OF_FIXTURE },
];
const ID_ROUTES = ROUTES.filter((route) => route.path.includes('/100'));
const ACTIONS = ROUTES.filter((route) => route.method === 'post' && route.name !== 'create');

/** Key paths described by an inline OpenAPI schema, in `jsonKeyPaths` form. */
function schemaKeyPaths(schema: SchemaObject, prefix = ''): string[] {
  if (schema.type === 'array') {
    return schemaKeyPaths(schema.items as SchemaObject, `${prefix}[]`);
  }

  return Object.entries(schema.properties ?? {}).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...schemaKeyPaths(child as SchemaObject, path)];
  });
}

/** Object schemas whose `required` list misses one of their properties. */
function optionalProperties(schema: SchemaObject, prefix = ''): string[] {
  if (schema.type === 'array') {
    return optionalProperties(schema.items as SchemaObject, `${prefix}[]`);
  }

  return Object.entries(schema.properties ?? {}).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [
      ...(schema.required?.includes(key) ? [] : [path]),
      ...optionalProperties(child as SchemaObject, path),
    ];
  });
}

/**
 * P2-08B: response contract of every booking endpoint, through the real JWT
 * strategy, role guard and ValidationPipe. BookingsService returns full
 * entities (with credentials, owner IDs and counters); the responses must
 * contain only the explicit projections, and Swagger must match them.
 */
describe('Booking API response contracts (P2-08B)', () => {
  let app: INestApplication;
  let document: OpenAPIObject;
  let tokens: Record<string, string>;
  const service = Object.fromEntries(
    ROUTES.map((route) => [route.serviceMethod, jest.fn()]),
  ) as Record<string, jest.Mock>;

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
    document = SwaggerModule.createDocument(app, new DocumentBuilder().build());

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
    for (const route of ROUTES) {
      service[route.serviceMethod]
        .mockReset()
        .mockResolvedValue(
          route.result === 'many'
            ? [bookingEntityFixture()]
            : bookingEntityFixture(),
        );
    }
  });

  const call = (route: Route, role?: string, path = route.path, body = route.body) => {
    const req = request(app.getHttpServer())[route.method](path);

    if (role) {
      req.set('Authorization', `Bearer ${tokens[role]}`);
    }

    return route.method === 'post' ? req.send(body ?? {}) : req;
  };

  const allowed = ROUTES.flatMap((route) =>
    route.roles.map((role) => [route.name, role, route] as const),
  );
  const denied = ROUTES.flatMap((route) =>
    ROLES.filter((role) => !route.roles.includes(role)).map(
      (role) => [route.name, role, route] as const,
    ),
  );

  describe('success responses', () => {
    it.each(allowed)('%s as %s answers the exact projection', async (_name, role, route) => {
      const res = await call(route, role);

      expect(res.status).toBe(route.status);
      expect(res.body).toEqual(route.expected);
      expect(service[route.serviceMethod]).toHaveBeenCalledTimes(1);
    });

    it.each(allowed)('%s as %s exposes no sensitive or internal field at any depth', async (_name, role, route) => {
      const res = await call(route, role);

      expect(forbiddenKeysIn(res.body)).toEqual([]);
      expect(JSON.stringify(res.body)).not.toMatch(
        /\$2b\$|@example\.com|0900000001|0911222333/,
      );
    });

    it('keeps the five lifecycle actions on HTTP 201', async () => {
      for (const route of ACTIONS) {
        expect((await call(route, route.roles[0])).status).toBe(201);
      }
    });

    it('gives creation, cancellation and the customer list the same item schema', async () => {
      const shapes = await Promise.all(
        ['create', 'cancel', 'customer list'].map(async (name) => {
          const route = ROUTES.find((r) => r.name === name)!;
          const res = await call(route, 'CUSTOMER');
          return jsonKeyPaths(route.result === 'many' ? res.body[0] : res.body).sort();
        }),
      );

      expect(shapes[1]).toEqual(shapes[0]);
      expect(shapes[2]).toEqual(shapes[0]);
    });

    it('gives every provider action the provider list item schema', async () => {
      const listItem = jsonKeyPaths(
        (await call(ROUTES.find((r) => r.name === 'provider list')!, 'PROVIDER_STAFF')).body[0],
      ).sort();

      for (const route of ACTIONS.filter((r) => r.roles === PROVIDER)) {
        expect(jsonKeyPaths((await call(route, 'PROVIDER_STAFF')).body).sort()).toEqual(listItem);
      }
    });

    it('passes the caller, the parsed ID and the body to the service', async () => {
      await call(ROUTES.find((r) => r.name === 'cancel')!, 'CUSTOMER');
      await call(ROUTES.find((r) => r.name === 'reject')!, 'PROVIDER_STAFF');

      expect(service.cancelMyBooking).toHaveBeenCalledWith('20', '100', { reason: 'Plans changed' });
      expect(service.rejectProviderBooking).toHaveBeenCalledWith(
        expect.objectContaining({ id: '31', role: 'PROVIDER_STAFF' }),
        '100',
        { reason: 'Fully staffed' },
      );
    });
  });

  describe('authorization and errors', () => {
    it.each(denied)('%s as %s -> 403 without calling the service', async (_name, role, route) => {
      expect((await call(route, role)).status).toBe(403);
      expect(service[route.serviceMethod]).not.toHaveBeenCalled();
    });

    it.each(ROUTES.map((route) => [route.name, route] as const))('%s without a token -> 401', async (_name, route) => {
      expect((await call(route)).status).toBe(401);
      expect(service[route.serviceMethod]).not.toHaveBeenCalled();
    });

    it.each(ID_ROUTES.map((route) => [route.name, route] as const))(
      '%s keeps the ownership 404 (another owner or missing booking)',
      async (_name, route) => {
        service[route.serviceMethod].mockRejectedValue(
          new NotFoundException('Booking not found'),
        );

        const res = await call(route, route.roles[0]);

        expect(res.status).toBe(404);
        expect(res.body.message).toBe('Booking not found');
      },
    );

    it.each(ID_ROUTES.map((route) => [route.name, route] as const))('%s with an invalid ID -> 400', async (_name, route) => {
      const res = await call(route, route.roles[0], route.path.replace('/100', '/abc'));

      expect(res.status).toBe(400);
      expect(service[route.serviceMethod]).not.toHaveBeenCalled();
    });

    it.each(ACTIONS.map((route) => [route.name, route] as const))('%s propagates lifecycle conflicts as 409', async (_name, route) => {
      service[route.serviceMethod].mockRejectedValue(
        new ConflictException('Only a confirmed booking can be updated'),
      );

      expect((await call(route, route.roles[0])).status).toBe(409);
    });

    it('rejects unknown body fields on actions with 400', async () => {
      const reject = ROUTES.find((r) => r.name === 'reject')!;

      expect((await call(reject, 'PROVIDER_OWNER', reject.path, { status: 'CONFIRMED' })).status).toBe(400);
      expect(service.rejectProviderBooking).not.toHaveBeenCalled();
    });
  });

  describe('Swagger', () => {
    const operation = (route: Route) => document.paths[route.swaggerPath][route.method]!;
    const successSchema = (route: Route) =>
      (operation(route).responses[String(route.status)] as ResponseObject)
        .content!['application/json'].schema as SchemaObject;

    it.each(ROUTES.map((route) => [route.name, route] as const))(
      '%s documents exactly its real success status',
      (_name, route) => {
        const success = Object.keys(operation(route).responses).filter((code) =>
          code.startsWith('2'),
        );

        expect(success).toEqual([String(route.status)]);
      },
    );

    it.each(ROUTES.map((route) => [route.name, route] as const))(
      '%s documents a success schema with exactly the fields it returns',
      async (_name, route) => {
        const res = await call(route, route.roles[0]);

        expect(schemaKeyPaths(successSchema(route)).sort()).toEqual(
          jsonKeyPaths(res.body).sort(),
        );
        expect(optionalProperties(successSchema(route))).toEqual([]);
      },
    );

    it.each(ROUTES.map((route) => [route.name, route] as const))(
      '%s documents 401 and 403, plus 400/404 for ID routes and 409 for writes',
      (_name, route) => {
        const codes = Object.keys(operation(route).responses);

        expect(codes).toEqual(expect.arrayContaining(['401', '403']));

        if (route.path.includes('/100')) {
          expect(codes).toEqual(expect.arrayContaining(['400', '404']));
        }

        if (route.method === 'post') {
          expect(codes).toEqual(expect.arrayContaining(['400', '404', '409']));
        }
      },
    );

    it('documents idempotent creation: optional key, replay header, key conflicts', () => {
      const create = operation(ROUTES[0]);

      expect(create.parameters).toContainEqual(
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: false }),
      );
      expect(
        (create.responses['201'] as { headers?: object }).headers,
      ).toHaveProperty('Idempotent-Replayed');
      expect((create.responses['409'] as { description: string }).description).toMatch(
        /different payload.*still in progress/s,
      );
      expect(create.description).toMatch(/same response schema as `GET \/bookings\/mine`/);
    });

    it('keeps sensitive field names out of every booking schema', () => {
      for (const route of ROUTES) {
        expect(forbiddenKeysIn(
          Object.fromEntries(schemaKeyPaths(successSchema(route)).map((path) => [path, 1])),
        )).toEqual([]);
      }
    });
  });
});
