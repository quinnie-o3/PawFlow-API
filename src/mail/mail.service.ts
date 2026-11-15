import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BackgroundTasks } from '../common/utils/background-tasks';
import {
  DEFAULT_MAIL_FROM,
  MAIL_TRANSPORT,
  type MailMessage,
  type MailTransport,
} from './mail-transport';

export const DEFAULT_FRONTEND_URL = 'http://localhost:3000';

/** `an@example.com` -> `a***@example.com` (logs never contain full addresses or content). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');

  return at > 0 ? `${email[0]}***${email.slice(at)}` : '***';
}

@Injectable()
export class MailService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(MailService.name);
  private readonly tasks = new BackgroundTasks(this.logger);

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    private readonly configService: ConfigService,
  ) {
    if (transport.name === 'disabled') {
      this.logger.warn(
        'MAIL_TRANSPORT is disabled: password-reset and verification e-mails are not sent (their links are revoked immediately)',
      );
    }
  }

  /**
   * Frontend link for a one-time token. The token goes in the fragment
   * (`/reset-password#token=…`). Base URL: `MAIL_LINK_BASE_URL`, else
   * `FRONTEND_URL`.
   */
  frontendLink(path: string, token: string): string {
    const base =
      this.configService.get<string>('MAIL_LINK_BASE_URL') ??
      this.configService.get<string>('FRONTEND_URL') ??
      DEFAULT_FRONTEND_URL;

    return `${base.replace(/\/+$/, '')}${path}#token=${encodeURIComponent(token)}`;
  }

  /**
   * Hands the message to the transport after the caller's transaction has
   * committed, without blocking the request. Never affects the request or
   * the database. Logs carry the category, masked recipient and transport,
   * never the content (which contains the link/token).
   *
   * "accepted" means the transport (SMTP server, outbox file) took the
   * message; it is not a confirmation of delivery to the inbox.
   *
   * `onUndelivered` runs when the message was not accepted (transport error
   * or transport disabled), e.g. to revoke the link nobody received.
   */
  dispatch(message: MailMessage, onUndelivered?: () => Promise<void>): void {
    const from = this.configService.get<string>('MAIL_FROM') ?? DEFAULT_MAIL_FROM;
    const label = `Mail ${message.category} to ${maskEmail(message.to)} via ${this.transport.name}`;

    this.tasks.run(label, async () => {
      if (this.transport.name === 'disabled') {
        this.logger.warn(`${label} not sent: MAIL_TRANSPORT is disabled`);
        await onUndelivered?.();
        return;
      }

      try {
        await this.transport.send({ ...message, from });
      } catch (error) {
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
        this.logger.error(`${label} failed (${reason})`);
        await onUndelivered?.();
        return;
      }

      this.logger.log(`${label} accepted`);
    });
  }

  /** Resolves when every queued message has been accepted, rejected or failed. */
  idle(): Promise<void> {
    return this.tasks.idle();
  }

  /** Drains queued e-mails while the database is still available (graceful shutdown). */
  async beforeApplicationShutdown(): Promise<void> {
    await this.idle();
  }
}
