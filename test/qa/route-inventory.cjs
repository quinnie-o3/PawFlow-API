/*
 * P3-BE10 route inventory: every HTTP route of the compiled application
 * (every dist *.controller.js file) with its guards and required roles, read from
 * the same Nest metadata the framework uses at runtime (PATH / METHOD /
 * __guards__ / roles; handler roles override class roles, as in
 * RolesGuard's getAllAndOverride). Nothing is hand-maintained, so a new
 * controller or handler is covered automatically by the security matrix.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];

function controllerFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return controllerFiles(full);
    return entry.name.endsWith('.controller.js') ? [full] : [];
  });
}

const join = (...parts) => '/' + parts.map((p) => String(p ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

/** [{ method, path, guards: string[], roles: string[] | null, controller, handler }] sorted by path. */
function routeInventory() {
  if (!fs.existsSync(DIST)) throw new Error('dist/ not found: run `npm run build` first');
  require(path.join(ROOT, 'node_modules', 'reflect-metadata'));
  const routes = [];
  for (const file of controllerFiles(DIST)) {
    for (const exported of Object.values(require(file))) {
      if (typeof exported !== 'function') continue;
      const base = Reflect.getMetadata('path', exported);
      if (base === undefined) continue;
      const classGuards = (Reflect.getMetadata('__guards__', exported) ?? []).map((g) => g.name);
      const classRoles = Reflect.getMetadata('roles', exported);
      for (const name of Object.getOwnPropertyNames(exported.prototype)) {
        const handler = exported.prototype[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const method = Reflect.getMetadata('method', handler);
        if (method === undefined) continue;
        const roles = Reflect.getMetadata('roles', handler) ?? classRoles ?? null;
        routes.push({
          method: METHODS[method],
          path: join(base, Reflect.getMetadata('path', handler)),
          guards: [...classGuards, ...(Reflect.getMetadata('__guards__', handler) ?? []).map((g) => g.name)],
          roles: roles && roles.length > 0 ? [...roles] : null,
          controller: exported.name,
          handler: name,
        });
      }
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** `/bookings/provider/:id/confirm` with every `:param` replaced by `value`. */
const fillParams = (routePath, value) => routePath.replace(/:[A-Za-z0-9_]+/g, String(value));

module.exports = { routeInventory, fillParams };
