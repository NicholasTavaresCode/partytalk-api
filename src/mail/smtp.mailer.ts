import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';
import { AppConfig } from '../config/configuration';
import { Mailer, MailMessage } from './mailer';

/**
 * Sends through an SMTP server — in HML, a dedicated Gmail account
 * authenticated with an App Password (port 465, implicit TLS). Without SMTP
 * credentials it stays disabled and only logs what it would have sent, so
 * local dev and tests never email anyone.
 */
@Injectable()
export class SmtpMailer extends Mailer {
  private readonly logger = new Logger(SmtpMailer.name);
  private readonly transporter?: Transporter;
  private readonly from?: string;
  readonly enabled: boolean;

  constructor(config: ConfigService<AppConfig, true>) {
    super();
    const mail = config.get('mail', { infer: true });
    this.enabled = !!(mail.smtpUser && mail.smtpPassword);
    if (this.enabled) {
      this.from = mail.from ?? `PartyTalk <${mail.smtpUser}>`;
      this.transporter = createTransport({
        host: mail.smtpHost,
        port: mail.smtpPort,
        secure: mail.smtpPort === 465,
        auth: { user: mail.smtpUser, pass: mail.smtpPassword },
        // Reuse one connection for a batch of invites instead of a login each.
        pool: true,
        maxConnections: 1,
      });
    }
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.transporter) {
      this.logger.log(
        `Email disabled (no SMTP credentials) — not sending "${message.subject}" to ${message.to}`,
      );
      return;
    }
    await this.transporter.sendMail({ from: this.from, ...message });
  }
}
