import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { emailVerificationEmail, passwordResetEmail } from './mail-templates';
import {
  createMailTransport,
  DisabledMailTransport,
  FileMailTransport,
  type MailMessage,
  type MailTransport,
  SmtpMailTransport,
} from './mail-transport';
import { maskEmail, MailService } from './mail.service';

function config(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (values[key] === undefined) throw new Error(`Configuration key "${key}" does not exist`);
      return values[key];
    },
  } as unknown as ConfigService;
}

const message: MailMessage = {
  category: 'PASSWORD_RESET',
  to: 'an@pawflow.test',
  subject: 'Reset',
  text: 'link http://fe.test/reset-password#token=SECRETTOKEN',
  html: '<a href="http://fe.test/reset-password#token=SECRETTOKEN">x</a>',
};

describe('Mail (P3-BE02)', () => {
  describe('createMailTransport', () => {
    it('defaults to the disabled transport (no credentials needed)', () => {
      expect(createMailTransport(config({}))).toBeInstanceOf(DisabledMailTransport);
      expect(createMailTransport(config({ MAIL_TRANSPORT: 'disabled' }))).toBeInstanceOf(DisabledMailTransport);
    });

    it('rejects unknown transports', () => {
      expect(() => createMailTransport(config({ MAIL_TRANSPORT: 'sendgrid' }))).toThrow('Unsupported MAIL_TRANSPORT');
    });

    it('builds an SMTP transport from the environment without connecting', () => {
      const transport = createMailTransport(
        config({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '2525', SMTP_USER: 'u', SMTP_PASSWORD: 'p' }),
      );
      expect(transport).toBeInstanceOf(SmtpMailTransport);
      expect(() => createMailTransport(config({ MAIL_TRANSPORT: 'smtp' }))).toThrow('SMTP_HOST');
    });

    it('fails fast on invalid SMTP settings without echoing secrets', () => {
      const base = { MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.test' };
      expect(() => createMailTransport(config({ ...base, SMTP_PORT: 'abc' }))).toThrow('SMTP_PORT must be an integer between 1 and 65535');
      expect(() => createMailTransport(config({ ...base, SMTP_PORT: '70000' }))).toThrow('SMTP_PORT');
      expect(() => createMailTransport(config({ ...base, SMTP_USER: 'mailer@pawflow.vn' }))).toThrow('SMTP_PASSWORD is required when SMTP_USER is set');
      expect(() => createMailTransport(config({ ...base, SMTP_USER: 'mailer@pawflow.vn', SMTP_PASSWORD: 's3cret!' }))).not.toThrow();
      expect(() => createMailTransport(config({ ...base }))).not.toThrow(); // unauthenticated relay, default port 587
    });

    it('refuses the file outbox in production and requires MAIL_OUTBOX_DIR', () => {
      expect(() => createMailTransport(config({ MAIL_TRANSPORT: 'file', NODE_ENV: 'production', MAIL_OUTBOX_DIR: tmpdir() }))).toThrow(
        'not allowed when NODE_ENV=production',
      );
      expect(() => createMailTransport(config({ MAIL_TRANSPORT: 'file' }))).toThrow('MAIL_OUTBOX_DIR');
    });
  });

  it('SmtpMailTransport passes the message and disables file/URL access', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    await new SmtpMailTransport({ sendMail } as never).send({ ...message, from: 'PawFlow <a@b.c>' });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'PawFlow <a@b.c>',
      to: 'an@pawflow.test',
      subject: 'Reset',
      text: message.text,
      html: message.html,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  });

  it('FileMailTransport writes one JSON file per message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pawflow-mail-spec-'));
    try {
      await new FileMailTransport(dir).send({ ...message, from: 'f' });
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(dir, files[0]), 'utf8'))).toMatchObject({ ...message, from: 'f', sentAt: expect.any(String) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('MailService', () => {
    it('builds fragment links from MAIL_LINK_BASE_URL, else FRONTEND_URL, else the default', () => {
      const transport = new DisabledMailTransport();
      expect(new MailService(transport, config({ MAIL_LINK_BASE_URL: 'https://app.test/', FRONTEND_URL: 'http://x' })).frontendLink('/reset-password', 'ab_-C')).toBe(
        'https://app.test/reset-password#token=ab_-C',
      );
      expect(new MailService(transport, config({ FRONTEND_URL: 'http://localhost:3001' })).frontendLink('/verify-email', 't')).toBe(
        'http://localhost:3001/verify-email#token=t',
      );
      expect(new MailService(transport, config({})).frontendLink('/verify-email', 't')).toBe('http://localhost:3000/verify-email#token=t');
    });

    it('sends with the configured sender after the call returns', async () => {
      const sent: unknown[] = [];
      const transport: MailTransport = { name: 'memory', send: (m) => (sent.push(m), Promise.resolve()) };
      const service = new MailService(transport, config({ MAIL_FROM: 'PawFlow <hello@pawflow.vn>' }));

      service.dispatch(message);
      expect(sent).toHaveLength(0);
      await service.idle();

      expect(sent).toEqual([{ ...message, from: 'PawFlow <hello@pawflow.vn>' }]);
    });

    it('logs delivery failures without recipient or content', async () => {
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const transport: MailTransport = { name: 'smtp', send: () => Promise.reject(new Error('EAUTH invalid login')) };
      const service = new MailService(transport, config({}));

      service.dispatch(message);
      await service.idle();

      expect(errors).toHaveBeenCalledWith('Mail PASSWORD_RESET to a***@pawflow.test via smtp failed (Error: EAUTH invalid login)');
      expect(JSON.stringify(errors.mock.calls)).not.toContain('SECRETTOKEN');
      expect(JSON.stringify(errors.mock.calls)).not.toContain('an@pawflow.test');
      errors.mockRestore();
    });

    it('with the disabled transport: warns at startup and per message (no content) and reports the message as undelivered', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const service = new MailService(new DisabledMailTransport(), config({}));
      const undelivered = jest.fn().mockResolvedValue(undefined);

      service.dispatch(message, undelivered);
      await service.idle();

      expect(warn).toHaveBeenNthCalledWith(1, expect.stringContaining('MAIL_TRANSPORT is disabled: password-reset and verification e-mails are not sent'));
      expect(warn).toHaveBeenCalledWith('Mail PASSWORD_RESET to a***@pawflow.test via disabled not sent: MAIL_TRANSPORT is disabled');
      expect(undelivered).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRETTOKEN');
      warn.mockRestore();
    });

    it('calls onUndelivered only when the transport rejects; logs "accepted" (not "delivered") on success', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      let fail = true;
      const transport: MailTransport = { name: 'smtp', send: () => (fail ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve()) };
      const service = new MailService(transport, config({}));
      const undelivered = jest.fn().mockResolvedValue(undefined);

      service.dispatch(message, undelivered);
      await service.idle();
      fail = false;
      service.dispatch(message, undelivered);
      await service.idle();

      expect(undelivered).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('Mail PASSWORD_RESET to a***@pawflow.test via smtp accepted');
      log.mockRestore();
      errors.mockRestore();
    });

    it('a failing onUndelivered handler is logged, never an unhandled rejection', async () => {
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      const service = new MailService({ name: 'smtp', send: () => Promise.reject(new Error('down')) }, config({}));

      service.dispatch(message, () => Promise.reject(new Error('db closed')));
      await service.idle();
      await new Promise((resolve) => setImmediate(resolve));

      expect(errors).toHaveBeenCalledWith('Mail PASSWORD_RESET to a***@pawflow.test via smtp failed (Error: db closed)');
      expect(unhandled).not.toHaveBeenCalled();
      process.off('unhandledRejection', unhandled);
      errors.mockRestore();
    });

    it('drains queued e-mails in beforeApplicationShutdown (database still open)', async () => {
      let release!: () => void;
      const sent: string[] = [];
      const transport: MailTransport = { name: 'smtp', send: () => new Promise<void>((resolve) => (release = () => (sent.push('x'), resolve()))) };
      const service = new MailService(transport, config({}));
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      service.dispatch(message);
      const drained = service.beforeApplicationShutdown();
      await new Promise((resolve) => setImmediate(resolve));
      release();
      await drained;

      expect(sent).toEqual(['x']);
      log.mockRestore();
    });

    it('masks addresses', () => {
      expect(maskEmail('an@pawflow.test')).toBe('a***@pawflow.test');
      expect(maskEmail('broken')).toBe('***');
    });
  });

  describe('templates', () => {
    const input = { to: 'an@pawflow.test', fullName: '<script>x</script>', link: 'http://fe.test/reset-password#token=T&x="y"', expiresInMinutes: 30 };

    it('password reset: link, lifetime, escaped HTML, separate category', () => {
      const mail = passwordResetEmail(input);
      expect(mail).toMatchObject({ category: 'PASSWORD_RESET', to: 'an@pawflow.test', subject: 'Reset your PawFlow password' });
      expect(mail.text).toContain(input.link);
      expect(mail.text).toContain('valid for 30 minutes');
      expect(mail.html).toContain('&lt;script&gt;x&lt;/script&gt;');
      expect(mail.html).not.toContain('<script>');
      expect(mail.html).toContain('token=T&amp;x=&quot;y&quot;');
    });

    it('verification: link and lifetime in hours/days', () => {
      expect(emailVerificationEmail({ ...input, expiresInMinutes: 1440 }).text).toContain('valid for 1 day');
      expect(emailVerificationEmail({ ...input, expiresInMinutes: 120 }).text).toContain('valid for 2 hours');
      expect(emailVerificationEmail({ ...input, fullName: '  ' }).text).toMatch(/^Hi there,/);
      expect(emailVerificationEmail(input)).toMatchObject({ category: 'EMAIL_VERIFICATION', subject: 'Verify your PawFlow e-mail address' });
    });
  });
});
