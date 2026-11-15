import type { Config } from 'jest';
import { pathsToModuleNameMapper } from 'ts-jest';
import ts from 'typescript';

// Path aliases (e.g. the ones added by `nest g library`) live in tsconfig.json,
// so they are read from there instead of being duplicated here.
const { config: tsconfig } = ts.readConfigFile(
  './tsconfig.json',
  ts.sys.readFile,
);
const paths = tsconfig?.compilerOptions?.paths ?? {};

const config: Config = {
  moduleFileExtensions: ['js', 'mjs', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    // ESM-only packages (NestJS 12, nodemailer 10, ...) -> CommonJS; see the
    // transformer for why. Listed first: Jest uses the first matching rule.
    '[\\\\/]node_modules[\\\\/].+\\.m?js$': '<rootDir>/test/jest/esm-node-modules.transform.cjs',
    // tsconfig.spec.json = tsconfig.json + explicit rootDir, which TypeScript 6
    // requires when ts-jest compiles a single file with an outDir (TS5011).
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  // node_modules must go through the transform above.
  transformIgnorePatterns: [],
  moduleNameMapper: pathsToModuleNameMapper(paths, { prefix: '<rootDir>/' }),
  collectCoverageFrom: [
    'src/**/*.(t|j)s',
    'libs/**/*.(t|j)s',
    'apps/**/*.(t|j)s',
  ],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
};

export default config;
