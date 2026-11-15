/*
 * Jest transform for JavaScript inside node_modules.
 *
 * NestJS 12 (and e.g. nodemailer 10) ship as ESM only ("type": "module").
 * The application itself runs as CommonJS on Node >= 22.12, which loads them
 * through native require(esm); Jest 30's module loader only does that on
 * Node >= 24.9. To keep `npm test` working on Node 22, ESM packages are
 * down-levelled to CommonJS here with the project's own TypeScript compiler
 * (no extra dependency). CommonJS files pass through unchanged.
 */
'use strict';

const { createHash } = require('crypto');
const ts = require('typescript');

const VERSION = '1';
const ESM_SYNTAX = /^\s*(import|export)\b|\bimport\.meta\b/m;

module.exports = {
  canInstrument: false,

  getCacheKey(source, filename) {
    return createHash('sha256').update(VERSION).update(ts.version).update(filename).update('\0').update(source).digest('hex');
  },

  process(source, filename) {
    if (!filename.endsWith('.mjs') && !ESM_SYNTAX.test(source)) {
      return { code: source };
    }

    const patched = source
      .replace(/import\.meta\.url/g, "require('url').pathToFileURL(__filename).href")
      .replace(/import\.meta\.dirname/g, '__dirname')
      .replace(/import\.meta\.filename/g, '__filename')
      // `const require = createRequire(import.meta.url)` would shadow the CommonJS require.
      .replace(/\b(const|let)\s+require\s*=/g, 'require =');

    const { outputText } = ts.transpileModule(patched, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        allowJs: true,
        esModuleInterop: true,
        sourceMap: false,
      },
    });

    return { code: outputText };
  },
};
