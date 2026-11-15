/*
 * P3-BE10 full-application E2E (test/*.e2e-spec.ts): same transforms as
 * jest.config.ts (ESM-only node_modules -> CommonJS, ts-jest with
 * tsconfig.spec.json), repository root as rootDir, longer timeout (a
 * disposable PostgreSQL database is created and migrated per run).
 * Patterns avoid backslashes so they match Windows and POSIX paths alike.
 */
'use strict';

module.exports = {
  rootDir: '..',
  moduleFileExtensions: ['js', 'mjs', 'json', 'ts'],
  testRegex: 'test/.*[.]e2e-spec[.]ts$',
  testEnvironment: 'node',
  testTimeout: 120000,
  globalSetup: '<rootDir>/test/e2e-global-setup.cjs',
  globalTeardown: '<rootDir>/test/e2e-global-teardown.cjs',
  transformIgnorePatterns: [],
  transform: {
    'node_modules.+[.]m?js$': '<rootDir>/test/jest/esm-node-modules.transform.cjs',
    '^.+[.](t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
};
