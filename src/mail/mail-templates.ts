import type { MailMessage } from './mail-transport';

/**
 * P3-BE02 e-mail templates. Links carry the token in the URL fragment
 * (`#token=…`), which browsers never send to servers or in `Referer`
 * headers, so it does not end up in frontend/proxy access logs.
 */

interface TemplateInput {
  to: string;
  fullName: string;
  link: string;
  expiresInMinutes: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function lifetime(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function layout(title: string, paragraphs: string[], action: { label: string; link: string }): string {
  return [
    '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1f2933;line-height:1.5">',
    `<h2>${escapeHtml(title)}</h2>`,
    ...paragraphs.map((p) => `<p>${p}</p>`),
    `<p><a href="${escapeHtml(action.link)}" style="display:inline-block;padding:10px 18px;background:#2f6fed;color:#fff;text-decoration:none;border-radius:6px">${escapeHtml(action.label)}</a></p>`,
    `<p style="font-size:12px;color:#65748b">If the button does not work, copy this link into your browser:<br>${escapeHtml(action.link)}</p>`,
    '</body></html>',
  ].join('');
}

export function passwordResetEmail(input: TemplateInput): MailMessage {
  const validity = lifetime(input.expiresInMinutes);
  const name = input.fullName.trim() || 'there';

  return {
    category: 'PASSWORD_RESET',
    to: input.to,
    subject: 'Reset your PawFlow password',
    text: [
      `Hi ${name},`,
      '',
      'We received a request to reset the password of your PawFlow account.',
      `Open this link to choose a new password (valid for ${validity}, usable once):`,
      input.link,
      '',
      'Resetting your password signs you out of every device.',
      'If you did not request this, you can ignore this e-mail; your password stays unchanged.',
    ].join('\n'),
    html: layout(
      'Reset your PawFlow password',
      [
        `Hi ${escapeHtml(name)},`,
        'We received a request to reset the password of your PawFlow account.',
        `The link is valid for ${validity} and can be used once. Resetting your password signs you out of every device.`,
        'If you did not request this, you can ignore this e-mail; your password stays unchanged.',
      ],
      { label: 'Choose a new password', link: input.link },
    ),
  };
}

export function emailVerificationEmail(input: TemplateInput): MailMessage {
  const validity = lifetime(input.expiresInMinutes);
  const name = input.fullName.trim() || 'there';

  return {
    category: 'EMAIL_VERIFICATION',
    to: input.to,
    subject: 'Verify your PawFlow e-mail address',
    text: [
      `Hi ${name},`,
      '',
      'Please confirm that this e-mail address belongs to your PawFlow account.',
      `Open this link to verify it (valid for ${validity}, usable once):`,
      input.link,
      '',
      'If you did not create a PawFlow account, you can ignore this e-mail.',
    ].join('\n'),
    html: layout(
      'Verify your e-mail address',
      [
        `Hi ${escapeHtml(name)},`,
        'Please confirm that this e-mail address belongs to your PawFlow account.',
        `The link is valid for ${validity} and can be used once.`,
        'If you did not create a PawFlow account, you can ignore this e-mail.',
      ],
      { label: 'Verify e-mail address', link: input.link },
    ),
  };
}
