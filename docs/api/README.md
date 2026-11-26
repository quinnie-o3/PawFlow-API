# PawFlow API contract (frozen at P3-BE12)

| File | What it is |
|---|---|
| [openapi.json](openapi.json) | OpenAPI 3.0 document of the whole API: 100 paths, 121 operations. Generated, never edited by hand. |
| [release-manifest.json](release-manifest.json) | Frozen inventories: the ordered migration chain (17), the machine-readable error codes, and the 68 operations whose success response has no schema yet (the list may only shrink). |

Release documentation: [../phase3/p3-be12-release-contract-freeze.md](../phase3/p3-be12-release-contract-freeze.md). FE feature → endpoint → error → evidence map: [../phase3/p3-be12-fe-be-traceability.md](../phase3/p3-be12-fe-be-traceability.md).

## Regenerate / verify

```bash
npm run build
npm run openapi:export   # rewrites docs/api/openapi.json from the compiled code
npm run openapi:check    # exit 1 if docs/api/openapi.json differs from the compiled code
npm run contract:check   # full freeze check (also runs in CI "verify")
```

The export needs **no database and no secret**. It loads the compiled `AppModule` in Nest *preview mode* (controllers are scanned, no provider is created) in a child process. That process runs in an empty temporary directory (the repository `.env` is never read), with an unreachable database address and a random throw-away JWT secret. It starts no worker and calls no external service. The document is built by `src/common/openapi/openapi-document.ts`, the same function that serves `/api/docs` at runtime. `qa:migration-cli` checks that the served `/api/docs-json` of a running application equals this file.

Comparisons use parsed JSON, so CRLF and LF checkouts compare equal. When the API changes, commit the regenerated `openapi.json` in the same pull request. CI fails otherwise.

## Using it in the frontend

- **Browse:** open `openapi.json` in any OpenAPI viewer (Swagger Editor, the VS Code OpenAPI extension). Or run the API locally (`SWAGGER_ENABLED` defaults to on outside staging/production) and open `http://localhost:8000/api/docs`. Swagger is **off** on staging/production unless `SWAGGER_ENABLED=true` is approved.
- **Types:** generate TypeScript types from the committed file, for example `npx openapi-typescript docs/api/openapi.json -o src/lib/api/schema.d.ts` in the frontend repository. This is a frontend dev dependency; the backend adds none. Operations listed in `release-manifest.json → responseSchemaGaps` have an untyped success body. Take their shape from [../phase2/mvp-fe-api-contract.md](../phase2/mvp-fe-api-contract.md) or the module document (links in the traceability matrix).
- **Base URL:** `NEXT_PUBLIC_API_URL=http://localhost:8000/api` locally. Every path in the document already starts with `/api`.
- **Auth:** `Authorization: Bearer <accessToken>` (`security: access-token`). Refresh with `POST /api/auth/refresh` (single-flight), see [../phase3/auth-sessions.md](../phase3/auth-sessions.md).
- **Bot protection:** register, login, forgot-password and reset-password require a `turnstileToken` body field when the server enforces Turnstile, which is mandatory on staging and production. See [../phase3/bot-protection.md](../phase3/bot-protection.md).
- **Errors:** `ErrorResponse` = `{ statusCode, message: string | string[], error?, code?, retryAfterSeconds? }`. Branch on `statusCode` and `code`, never on the English `message`.
- **Cross-cutting:** every response has `X-Request-ID` (show it in error reports). Every operation except `/api/health/*` can return `429 RATE_LIMITED` (honour `Retry-After`) and `503 RATE_LIMIT_UNAVAILABLE`. CORS allows only the exact origins in `CORS_ORIGINS`.
- **Data types:** IDs are strings; NUMERIC values are strings with two decimals; slot dates/times are business-local (Asia/Ho_Chi_Minh) without a time zone.
