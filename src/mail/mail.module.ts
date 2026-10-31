import { Global, Module } from '@nestjs/common';
import { Mailer } from './mailer';
import { SmtpMailer } from './smtp.mailer';

/** Binds the Mailer token to SMTP. Global, so any feature can inject Mailer. */
@Global()
@Module({
  providers: [{ provide: Mailer, useClass: SmtpMailer }],
  exports: [Mailer],
})
export class MailModule {}
