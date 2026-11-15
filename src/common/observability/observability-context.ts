import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * P3-BE09 correlation context, propagated with AsyncLocalStorage so that
 * concurrent requests and jobs never share or overwrite each other's state
 * (no request-scoped providers, no global mutable "current request").
 */

/** Per-request state. One object per HTTP request, also attached to `req`. */
export interface RequestContext {
  readonly requestId: string;
  /** process.hrtime.bigint() when the request entered the application. */
  readonly startedAt: bigint;
  /** Safe failure annotations set by the exception filters, reported once by the completion log. */
  errorCode?: string;
  errorName?: string;
  dbCode?: string;
}

/** Background job correlation (a job is never tied to the request that enqueued it). */
export interface JobContext {
  readonly jobId: string;
  readonly attempt?: number;
}

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

/** A structured event attached to exactly one log call (see logEvent). */
export interface PendingLogEvent {
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

interface ObservabilityStore {
  readonly request?: RequestContext;
  readonly job?: JobContext;
  readonly event?: PendingLogEvent;
}

const storage = new AsyncLocalStorage<ObservabilityStore>();

export function runWithRequestContext<T>(request: RequestContext, fn: () => T): T {
  return storage.run({ request }, fn);
}

export function runWithJobContext<T>(job: JobContext, fn: () => T): T {
  return storage.run({ job }, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore()?.request;
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.request?.requestId;
}

export function currentJobContext(): JobContext | undefined {
  return storage.getStore()?.job;
}

/** The structured event of the log call in progress, if it was made through logEvent. */
export function currentPendingEvent(): PendingLogEvent | undefined {
  return storage.getStore()?.event;
}

type EventLogger = {
  log(message: string): unknown;
  warn(message: string): unknown;
  error(message: string): unknown;
  debug(message: string): unknown;
};

/**
 * Logs `message` through an ordinary Nest Logger and attaches a structured
 * event (`event` name + allowlisted `fields`) to that single call. The
 * application's StructuredLogger renders the event fields; any other
 * LoggerService (tests, QA overrides) still receives the plain message, so
 * existing human-readable lines keep their exact text.
 *
 * `request` overrides the ambient request context (used by the HTTP
 * completion log, which runs from a socket callback). Never throws.
 */
export function logEvent(
  logger: EventLogger,
  level: EventLevel,
  event: string,
  fields: Record<string, unknown>,
  message: string,
  request?: RequestContext,
): void {
  const parent = storage.getStore();
  try {
    storage.run(
      { request: request ?? parent?.request, job: parent?.job, event: { event, fields } },
      () => {
        if (level === 'info') logger.log(message);
        else logger[level](message);
      },
    );
  } catch {
    // Operational logging is best effort and must not fail the caller.
  }
}
