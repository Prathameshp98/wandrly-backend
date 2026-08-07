/**
 * Transactional email.
 *
 * TECHNICAL_DESIGN §12: optional integrations are genuinely optional. With no
 * RESEND_API_KEY the service LOGS the message instead of sending it, so local
 * development and CI need no third-party account and no network.
 */

import { env, isProduction } from '../config/env';
import { loggerFor } from '../logging/logger';

const log = loggerFor('email');

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface EmailService {
  send(message: EmailMessage): Promise<boolean>;
}

/** Escape interpolated values — invite notes and trip titles are user input. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class ResendEmailService implements EmailService {
  async send(message: EmailMessage): Promise<boolean> {
    if (!env.RESEND_API_KEY) {
      // Not an error: the feature degrades rather than failing the request that
      // triggered it (FR-NFR-REL-04).
      log.info(
        { to: message.to, subject: message.subject },
        'email not sent (no provider configured) — logging instead',
      );
      if (!isProduction) log.debug({ text: message.text }, 'email body');
      return false;
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        log.error({ status: response.status, to: message.to }, 'email provider rejected');
        return false;
      }

      return true;
    } catch (error) {
      // A failed email must never fail the user's request.
      log.error({ err: error, to: message.to }, 'email send failed');
      return false;
    }
  }
}

export const emailService: EmailService = new ResendEmailService();

export function inviteEmail(input: {
  tripTitle: string;
  inviterName: string;
  role: string;
  personalNote?: string | null;
  joinUrl: string;
}): Omit<EmailMessage, 'to'> {
  const note = input.personalNote ? `\n\n"${input.personalNote}"\n` : '\n';

  return {
    subject: `${input.inviterName} invited you to "${input.tripTitle}"`,
    text:
      `${input.inviterName} has invited you to help plan "${input.tripTitle}" ` +
      `as a ${input.role.toLowerCase()}.${note}\n` +
      `Join here: ${input.joinUrl}\n\nThis invite expires in 30 days.`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto">
        <h2 style="font-weight:600">You're invited to a journey</h2>
        <p><strong>${escapeHtml(input.inviterName)}</strong> has invited you to help plan
           <strong>${escapeHtml(input.tripTitle)}</strong> as a
           ${escapeHtml(input.role.toLowerCase())}.</p>
        ${input.personalNote ? `<blockquote style="border-left:3px solid #F0A05A;padding-left:12px;color:#555">${escapeHtml(input.personalNote)}</blockquote>` : ''}
        <p><a href="${escapeHtml(input.joinUrl)}"
              style="display:inline-block;background:#F0A05A;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">Join the trip</a></p>
        <p style="color:#888;font-size:13px">This invite expires in 30 days.</p>
      </div>`,
  };
}
