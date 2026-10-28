import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { Mailer, MailMessage } from '../mail/mailer';
import { Room } from './entities/room.entity';

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

/**
 * Emails people when the owner invites them to a room. Sending never blocks or
 * fails the invite itself: the invite list is what grants access, and the
 * email is a courtesy — failures are logged.
 */
@Injectable()
export class RoomInvitations {
  private readonly logger = new Logger(RoomInvitations.name);
  private readonly webAppUrl: string;

  constructor(
    private readonly mailer: Mailer,
    config: ConfigService<AppConfig, true>,
  ) {
    this.webAppUrl = config.get('mail', { infer: true }).webAppUrl;
  }

  /** Fire-and-forget: one email per address, sent in the background. */
  send(
    room: Room,
    host: { name?: string; email?: string },
    emails: string[],
  ): void {
    for (const to of emails) {
      this.mailer
        .send(this.compose(room, host, to))
        .catch((error: Error) =>
          this.logger.warn(
            `Invitation email to ${to} for room ${room.id} failed: ${error.message}`,
          ),
        );
    }
  }

  compose(
    room: Room,
    host: { name?: string; email?: string },
    to: string,
  ): MailMessage {
    const hostName = host.name || host.email || 'Someone';
    const link = `${this.webAppUrl}/practice/${room.id}`;
    const subject = `${hostName} invited you to a PartyTalk room: “${room.topic}”`;
    const text = [
      `${hostName} invited you to practise English in a live PartyTalk room.`,
      '',
      `Topic: ${room.topic}`,
      `Join: ${link}`,
      '',
      `Sign in with the Google account for ${to} — the room is invite-only.`,
    ].join('\n');
    const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f5f8;font-family:Arial,Helvetica,sans-serif;color:#1b1b1f">
  <table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">
    <tr><td>
      <p style="margin:0 0 4px;font-size:13px;font-weight:bold;letter-spacing:.04em;text-transform:uppercase;color:#4f5b93">PartyTalk</p>
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(hostName)} invited you to a live room</h1>
      <p style="margin:0 0 6px;font-size:14px;color:#5b5d67">Topic</p>
      <p style="margin:0 0 24px;font-size:18px;font-weight:bold">“${escapeHtml(room.topic)}”</p>
      <a href="${link}" style="display:inline-block;background:#2b3a8c;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px">Join the room</a>
      <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#5b5d67">The room is invite-only: sign in with the Google account for <b>${escapeHtml(to)}</b>.<br>Link: <a href="${link}" style="color:#2b3a8c">${link}</a></p>
    </td></tr>
  </table>
</body></html>`;
    return { to, subject, text, html };
  }
}
