/**
 * Authentication is global (JwtAuthGuard + RolesGuard as APP_GUARD): a route is
 * protected unless its controller or handler carries @Public(). These helpers
 * read the same metadata the global JwtAuthGuard reads at runtime.
 */
import { IS_PUBLIC_KEY } from '../../src/auth/decorators/public.decorator';

type ControllerClass = abstract new (...args: never[]) => unknown;

const handlerNames = (controller: ControllerClass): string[] =>
  Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor');

const handlerOf = (controller: ControllerClass, name: string): object =>
  (controller.prototype as Record<string, object>)[name];

/** True when the global JwtAuthGuard skips this handler (handler or class @Public()). */
export function isPublicRoute(controller: ControllerClass, handler: string): boolean {
  return (
    Reflect.getMetadata(IS_PUBLIC_KEY, handlerOf(controller, handler)) === true ||
    Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true
  );
}

/** Asserts every handler of the controller (or only `handler`) requires authentication. */
export function expectAuthenticated(controller: ControllerClass, handler?: string): void {
  const names = handler ? [handler] : handlerNames(controller);
  expect(names.length).toBeGreaterThan(0);
  expect(names.filter((name) => isPublicRoute(controller, name))).toEqual([]);
}
