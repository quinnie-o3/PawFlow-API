import type { LoggerService } from '@nestjs/common';

import {
  ERROR_NAME_PATTERN,
  safeContextName,
  safeEventName,
  safeJobId,
  sanitizeEventFields,
  sanitizeLogText,
} from './log-fields';
import {
  currentJobContext,
  currentPendingEvent,
  currentRequestContext,
} from './observability-context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogFormat = 'json' | 'text';

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export interface LoggingConfig {
  readonly format: LogFormat;
  readonly minLevel: LogLevel;
}

/**
 * LOG_FORMAT: `json` (default, one JSON object per line) or `text`
 * (human-readable, development only: refused when NODE_ENV=production).
 * LOG_LEVEL: debug | info | warn | error | fatal; default `info` in
 * production, `debug` otherwise. Invalid values stop the startup.
 */
export function loadLoggingConfig(env: Readonly<Record<string, string | undefined>>): LoggingConfig {
  const production = env.NODE_ENV === 'production';

  const format = (env.LOG_FORMAT ?? 'json').trim().toLowerCase();
  if (format !== 'json' && format !== 'text') {
    throw new Error('LOG_FORMAT must be "json" or "text"');
  }
  if (format === 'text' && production) {
    throw new Error('LOG_FORMAT=text is not allowed when NODE_ENV=production');
  }

  const level = (env.LOG_LEVEL ?? (production ? 'info' : 'debug')).trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(LEVEL_RANK, level)) {
    throw new Error('LOG_LEVEL must be one of debug, info, warn, error, fatal');
  }

  return { format, minLevel: level as LogLevel };
}

/**
 * P3-BE09 application logger (replaces Nest's ConsoleLogger).
 *
 * Every line has a fixed shape, in this key order:
 *   timestamp, level, event, context?, requestId?, jobId?, attempt?,
 *   <allowlisted event fields>, message?, errorName?
 *
 * - `event` is `app.log` for ordinary Logger calls, or the name given to
 *   logEvent (e.g. `http.request.completed`).
 * - `requestId` / `jobId` come from the AsyncLocalStorage context.
 * - Messages are single-line, bounded and scrubbed (see log-fields.ts).
 * - Error objects are never serialized: only the class name and the
 *   scrubbed message are kept; stack traces are never written.
 *
 * A logging failure is swallowed: it can never fail a request or a job.
 */
export class StructuredLogger implements LoggerService {
  constructor(
    private readonly config: LoggingConfig,
    private readonly write: (line: string) => void = (line) => {
      process.stdout.write(`${line}\n`);
    },
  ) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('debug', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('fatal', message, optionalParams);
  }

  private emit(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    try {
      if (LEVEL_RANK[level] < LEVEL_RANK[this.config.minLevel]) return;
      const record = this.buildRecord(level, message, optionalParams);
      this.write(this.config.format === 'json' ? JSON.stringify(record) : renderText(record));
    } catch {
      // Best effort: never propagate a logging failure.
    }
  }

  private buildRecord(level: LogLevel, message: unknown, optionalParams: unknown[]): Record<string, unknown> {
    const pending = currentPendingEvent();
    const request = currentRequestContext();
    const job = currentJobContext();

    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      event: safeEventName(pending?.event) ?? 'app.log',
    };

    // Nest passes the logger context as the last string parameter.
    const context = safeContextName(optionalParams.at(-1));
    if (context) record.context = context;
    if (request) record.requestId = request.requestId;

    const jobId = safeJobId(job?.jobId);
    if (jobId) {
      record.jobId = jobId;
      if (Number.isInteger(job?.attempt)) record.attempt = job?.attempt;
    }

    if (pending) Object.assign(record, sanitizeEventFields(pending.fields));

    if (typeof message === 'string' || typeof message === 'number' || typeof message === 'boolean') {
      const text = sanitizeLogText(String(message));
      if (text) record.message = text;
    } else if (message instanceof Error) {
      // Startup failures (e.g. configuration errors) reach the logger as Error objects
      // through Nest's ExceptionHandler; their message is the only explanation an
      // operator gets. It is scrubbed like any message; properties such as a
      // database `detail` and the stack are never written. Request-path errors do
      // not come here: ObservabilityExceptionFilter logs class + SQLSTATE only.
      const text = sanitizeLogText(message.message);
      if (text) record.message = text;
      record.errorName = ERROR_NAME_PATTERN.test(message.name) ? message.name : 'Error';
    } else if (message !== undefined && message !== null) {
      record.message = '[non-text message omitted]';
    }

    return record;
  }
}

function renderText(record: Record<string, unknown>): string {
  const { timestamp, level, event, context, message, ...fields } = record;
  const extras = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  return [
    String(timestamp),
    String(level).toUpperCase().padEnd(5),
    context ? `[${String(context)}]` : '',
    event === 'app.log' ? '' : String(event),
    message === undefined ? '' : String(message),
    extras,
  ]
    .filter(Boolean)
    .join(' ');
}
