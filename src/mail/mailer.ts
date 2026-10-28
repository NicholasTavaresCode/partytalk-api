export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Outgoing email, behind an abstract class used as the DI token so senders can
 * be swapped (SMTP today) or faked in tests without touching callers
 * (di-use-interfaces-tokens, test-mock-external-services).
 */
export abstract class Mailer {
  /** Whether mail actually leaves the process (false = only logged). */
  abstract readonly enabled: boolean;
  abstract send(message: MailMessage): Promise<void>;
}
