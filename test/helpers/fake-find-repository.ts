type FindOptions = {
  select: Record<string, boolean>;
  where: Record<string, unknown>;
  order: Record<string, 'ASC' | 'DESC'>;
};

/**
 * In-memory stand-in for TypeORM `Repository.find` used by unit tests.
 *
 * Applies the equality `where`, multi-key `order` and `select` projection
 * passed by the code under test, so filtering and ordering are exercised
 * against row data instead of being assumed. `id` keys compare as BIGINT.
 */
export function createFakeFindRepository(
  rows: Array<Record<string, unknown>>,
) {
  const compare = (key: string, a: unknown, b: unknown) =>
    key === 'id'
      ? Number(BigInt(a as string) - BigInt(b as string))
      : String(a).localeCompare(String(b));

  return {
    find: jest.fn((options: FindOptions) => {
      const matched = rows.filter((row) =>
        Object.entries(options.where).every(
          ([key, value]) => row[key] === value,
        ),
      );

      matched.sort((a, b) => {
        for (const [key, direction] of Object.entries(options.order)) {
          const result = compare(key, a[key], b[key]);

          if (result !== 0) {
            return direction === 'ASC' ? result : -result;
          }
        }

        return 0;
      });

      return Promise.resolve(
        matched.map((row) =>
          Object.fromEntries(
            Object.keys(options.select)
              .filter((key) => options.select[key])
              .map((key) => [key, row[key]]),
          ),
        ),
      );
    }),
  };
}
