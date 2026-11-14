import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';

import { findOverlappingWorkingInterval } from '../availability/slot-eligibility';
import { Booking } from '../bookings/entities/booking.entity';
import { ProviderStaff } from './entities/provider-staff.entity';
import { ProviderWorkingHour } from './entities/provider-working-hour.entity';
import { Provider } from './entities/provider.entity';
import { ProvidersService } from './providers.service';

type Row = Partial<ProviderWorkingHour> & { id: string };

const MONDAY = 1;
const interval = (startTime: string, endTime: string, dayOfWeek = MONDAY) => ({
  dayOfWeek,
  startTime,
  endTime,
});

describe('findOverlappingWorkingInterval (P2-09B)', () => {
  const existing = [{ id: 'a', ...interval('08:00:00', '12:00:00') }];

  it.each([
    ['separate 13:00-17:00', '13:00', '17:00', false],
    ['adjacent after 12:00-17:00', '12:00', '17:00', false],
    ['adjacent before 06:00-08:00', '06:00', '08:00', false],
    ['partial 11:00-14:00', '11:00', '14:00', true],
    ['partial 07:00-08:01', '07:00', '08:01', true],
    ['contained 09:00-10:00', '09:00', '10:00', true],
    ['containing 07:00-13:00', '07:00', '13:00', true],
    ['duplicate 08:00-12:00', '08:00', '12:00', true],
    ['one second inside 11:59:59-13:00', '11:59:59', '13:00', true],
    ['touching to the second 12:00:00-13:00', '12:00:00', '13:00', false],
  ])('%s -> overlap %s', (_label, startTime, endTime, overlaps) => {
    expect(
      findOverlappingWorkingInterval(interval(startTime, endTime), existing),
    ).toEqual(overlaps ? existing[0] : undefined);
  });

  it('ignores other weekdays', () => {
    expect(
      findOverlappingWorkingInterval(interval('08:00', '12:00', 2), existing),
    ).toBeUndefined();
  });
});

/**
 * Stateful in-memory schedule: `find` honours its `where` filter and a
 * transaction restores a snapshot when it throws, like PostgreSQL rollback.
 * The real concurrent behaviour is verified by the PostgreSQL QA harness.
 */
function createHarness(approvalStatus: Provider['approvalStatus'] = 'APPROVED') {
  const provider = { id: '1', ownerId: '10', approvalStatus } as Provider;
  const state = {
    rows: [] as Row[],
    bookings: [] as Booking[],
    nextId: 100,
  };
  const events: string[] = [];
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(
      ([key, value]) => (row as Record<string, unknown>)[key] === value,
    );

  const workingHours = {
    find: ({ where }: { where: Record<string, unknown> }) => {
      events.push('find');
      return Promise.resolve(
        state.rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
      );
    },
    findOne: ({ where }: { where: Record<string, unknown> }) => {
      const row = state.rows.find((candidate) => matches(candidate, where));
      return Promise.resolve(row ? { ...row } : null);
    },
    create: (value: Partial<ProviderWorkingHour>) => ({ ...value }),
    save: (value: Row) => {
      events.push('save');
      const duplicate = state.rows.find(
        (row) =>
          row.id !== value.id &&
          row.dayOfWeek === value.dayOfWeek &&
          row.startTime?.slice(0, 5) === value.startTime?.slice(0, 5) &&
          row.endTime?.slice(0, 5) === value.endTime?.slice(0, 5),
      );

      if (duplicate) {
        return Promise.reject(Object.assign(new Error('unique'), { code: '23505' }));
      }

      if (value.id === undefined) {
        value.id = String(state.nextId++);
        state.rows.push({ ...value });
      } else {
        Object.assign(state.rows.find((row) => row.id === value.id)!, value);
      }

      return Promise.resolve({ ...value });
    },
  };
  const providers = {
    findOne: (options: { lock?: { mode: string } }) => {
      events.push(options.lock ? `provider:${options.lock.mode}` : 'provider:read');
      return Promise.resolve(provider);
    },
  };
  const bookings = { find: () => Promise.resolve(state.bookings) };
  const manager = {
    getRepository: (entity: unknown) =>
      entity === Provider ? providers : entity === Booking ? bookings : workingHours,
  };
  const dataSource = {
    transaction: async (work: (m: object) => Promise<unknown>) => {
      events.push('begin');
      const snapshot = structuredClone(state);

      try {
        return await work(manager);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      } finally {
        events.push('end');
      }
    },
  };

  const add = (startTime: string, endTime: string, isActive = true, dayOfWeek = MONDAY) => {
    const id = String(state.nextId++);
    state.rows.push({ id, providerId: '1', dayOfWeek, startTime, endTime, isActive });
    return id;
  };

  return {
    state,
    events,
    add,
    service: new ProvidersService(
      providers as unknown as Repository<Provider>,
      {} as Repository<ProviderStaff>,
      workingHours as unknown as Repository<ProviderWorkingHour>,
      dataSource as unknown as DataSource,
    ),
  };
}

describe('Working-hours overlap prevention (P2-09B)', () => {
  const OVERLAP = /overlaps the active entry 08:00:00-12:00:00 on the same day/;
  let h: ReturnType<typeof createHarness>;
  const create = (startTime: string, endTime: string, extra = {}) =>
    h.service.createMyWorkingHour('10', { dayOfWeek: MONDAY, startTime, endTime, ...extra });

  beforeEach(() => {
    h = createHarness();
    h.add('08:00:00', '12:00:00');
  });

  describe('create', () => {
    it.each([
      ['a separate interval', '13:00', '17:00'],
      ['an adjacent interval (not merged)', '12:00', '17:00'],
    ])('allows %s', async (_label, startTime, endTime) => {
      await expect(create(startTime, endTime)).resolves.toMatchObject({ startTime, endTime });
      expect(h.state.rows).toHaveLength(2);
    });

    it.each([
      ['a partial overlap', '11:00', '14:00'],
      ['a contained interval', '09:00', '10:00'],
      ['a containing interval', '07:00', '13:00'],
      ['an exact duplicate', '08:00', '12:00'],
    ])('rejects %s with 409 and inserts nothing', async (_label, startTime, endTime) => {
      await expect(create(startTime, endTime)).rejects.toThrow(OVERLAP);
      expect(h.state.rows).toHaveLength(1);
      expect(h.events).not.toContain('save');
    });

    it('allows the same hours on another weekday', async () => {
      await expect(create('08:00', '12:00', { dayOfWeek: 2 })).resolves.toBeDefined();
    });

    it('allows an overlapping entry created inactive', async () => {
      await expect(create('09:00', '10:00', { isActive: false })).resolves.toMatchObject({
        isActive: false,
      });
    });

    it('ignores inactive entries when checking', async () => {
      h.state.rows[0].isActive = false;

      await expect(create('09:00', '10:00')).resolves.toBeDefined();
    });

    it('keeps the 409 for an identical (inactive) entry from the unique constraint', async () => {
      h.state.rows[0].isActive = false;

      await expect(create('08:00', '12:00')).rejects.toThrow(
        new ConflictException('This working-hour entry already exists'),
      );
      expect(h.state.rows).toHaveLength(1);
    });

    it('checks and inserts inside one transaction holding the provider row FOR UPDATE', async () => {
      await create('13:00', '17:00');

      expect(h.events).toEqual([
        'provider:read',
        'begin',
        'provider:pessimistic_write',
        'find',
        'save',
        'end',
      ]);
    });

    it('keeps the 400 for an invalid or overnight range before any transaction', async () => {
      await expect(create('22:00', '02:00')).rejects.toThrow('startTime must be earlier than endTime');
      expect(h.events).not.toContain('begin');
    });
  });

  describe('update and reactivation', () => {
    const update = (id: string, dto: object) => h.service.updateMyWorkingHour('10', id, dto);

    it('excludes the entry itself (extending 08:00-12:00 to 13:00)', async () => {
      await expect(update(h.state.rows[0].id, { endTime: '13:00' })).resolves.toMatchObject({
        endTime: '13:00',
      });
    });

    it.each([
      ['moving into another entry', MONDAY, { startTime: '11:00', endTime: '14:00' }],
      ['moving onto the weekday of another entry', 2, { dayOfWeek: MONDAY, startTime: '10:00', endTime: '11:00' }],
    ])('rejects %s with 409 and changes nothing', async (_label, day, dto) => {
      const other = h.add('13:00:00', '17:00:00', true, day);
      const before = structuredClone(h.state.rows);

      await expect(update(other, dto)).rejects.toThrow(OVERLAP);
      expect(h.state.rows).toEqual(before);
    });

    it('allows moving to an adjacent position', async () => {
      const other = h.add('13:00:00', '17:00:00');

      await expect(update(other, { startTime: '12:00' })).resolves.toMatchObject({ startTime: '12:00' });
    });

    it('rejects reactivating an overlapping inactive entry', async () => {
      const inactive = h.add('09:00:00', '10:00:00', false);

      await expect(update(inactive, { isActive: true })).rejects.toThrow(OVERLAP);
      expect(h.state.rows.find((row) => row.id === inactive)!.isActive).toBe(false);
    });

    it('allows editing an inactive overlapping entry while it stays inactive', async () => {
      const inactive = h.add('09:00:00', '10:00:00', false);

      await expect(update(inactive, { endTime: '11:00' })).resolves.toMatchObject({ isActive: false });
    });

    it('allows reactivating a non-overlapping entry', async () => {
      const inactive = h.add('12:00:00', '17:00:00', false);

      await expect(update(inactive, { isActive: true })).resolves.toMatchObject({ isActive: true });
    });

    it('treats 08:00 and 08:00:00 as unchanged (no check for a same-value PATCH)', async () => {
      h.add('09:00:00', '10:00:00'); // historical overlap
      h.events.length = 0;

      await expect(
        update(h.state.rows[0].id, { startTime: '08:00', endTime: '12:00', isActive: true }),
      ).resolves.toBeDefined();
    });
  });

  describe('historical overlapping entries (no automatic repair)', () => {
    let overlapping: string;

    beforeEach(() => {
      overlapping = h.add('11:00:00', '14:00:00'); // created before P2-09B
    });

    it('leaves them untouched and lets unrelated entries be created', async () => {
      await expect(create('15:00', '17:00')).resolves.toBeDefined();
      expect(h.state.rows.filter((row) => row.isActive)).toHaveLength(3);
    });

    it('allows deactivating either of them (the remediation path)', async () => {
      await expect(h.service.deactivateMyWorkingHour('10', overlapping)).resolves.toBeUndefined();
    });

    it('allows resolving the overlap by shrinking one of them', async () => {
      await expect(
        h.service.updateMyWorkingHour('10', overlapping, { startTime: '12:00' }),
      ).resolves.toMatchObject({ startTime: '12:00' });
    });

    it('rejects a change that still overlaps', async () => {
      await expect(
        h.service.updateMyWorkingHour('10', overlapping, { endTime: '15:00' }),
      ).rejects.toThrow(OVERLAP);
    });
  });

  describe('interaction with active bookings (P2-06B)', () => {
    const monday = (() => {
      const date = new Date();
      date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7));
      const pad = (value: number) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    })();

    beforeEach(() => {
      h.state.bookings = [
        { id: '9', status: 'CONFIRMED', slot: { slotDate: monday, startTime: '09:00:00', endTime: '10:00:00' } } as unknown as Booking,
      ];
    });

    it('still rejects a non-overlapping change that strands an active booking', async () => {
      await expect(
        h.service.updateMyWorkingHour('10', h.state.rows[0].id, { startTime: '10:00' }),
      ).rejects.toThrow('would leave 1 active booking(s) outside working hours');
      expect(h.state.rows[0].startTime).toBe('08:00:00');
    });

    it('reports the overlap first when a change both overlaps and strands a booking', async () => {
      const other = h.add('13:00:00', '17:00:00');

      await expect(
        h.service.updateMyWorkingHour('10', h.state.rows[0].id, { startTime: '10:00', endTime: '14:00' }),
      ).rejects.toThrow(/overlaps the active entry 13:00:00-17:00:00/);
      expect(h.state.rows.find((row) => row.id === other)!.startTime).toBe('13:00:00');
    });

    it('never modifies or cancels bookings', async () => {
      await h.service.updateMyWorkingHour('10', h.state.rows[0].id, { endTime: '13:00' });

      expect(h.state.bookings[0].status).toBe('CONFIRMED');
    });
  });

  describe('authorization', () => {
    it.each(['REJECTED', 'SUSPENDED'] as Array<Provider['approvalStatus']>)(
      'a %s provider gets 403 before any transaction',
      async (approvalStatus) => {
        h = createHarness(approvalStatus);

        await expect(create('13:00', '17:00')).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.events).not.toContain('begin');
      },
    );

    it("returns 404 for another provider's entry without checking overlaps", async () => {
      const foreign = h.add('13:00:00', '17:00:00');
      h.state.rows.find((row) => row.id === foreign)!.providerId = '2';
      h.events.length = 0;

      await expect(
        h.service.updateMyWorkingHour('10', foreign, { startTime: '09:00' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(h.events).not.toContain('find');
    });
  });
});
