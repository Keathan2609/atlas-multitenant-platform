import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from '@atlas/observability';
import { CONFIG_TOKEN, type AppConfig } from '../../config/env.js';
import { LOGGER_TOKEN } from '../logging/logger.provider.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Outbound email.
 *
 * Three transports, selected by EMAIL_TRANSPORT:
 *
 *   smtp     Sends through the local Mailpit container in development, or a
 *            real relay in production. Mailpit accepts everything and shows
 *            it at http://localhost:8025, so the invitation flow is fully
 *            exercisable with no third-party account.
 *   console  Renders to the log. Used by the integration suite, so tests can
 *            assert on delivery without a live SMTP socket.
 *   noop     Discards. For environments where email is genuinely unwanted.
 *
 * Sending is deliberately best-effort and never throws into the caller. An
 * invitation row and its audit entry are committed transactionally; if the
 * SMTP hop then fails, the invitation still exists and can be resent. Letting
 * a mail failure roll back the invitation would make the product's
 * correctness depend on a remote service being up.
 */
@Injectable()
export class EmailService implements OnModuleDestroy {
  private readonly transporter?: Transporter;
  /** Retained in `console` mode so tests can assert what would have been sent. */
  readonly sent: EmailMessage[] = [];

  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
    @Inject(LOGGER_TOKEN) private readonly logger: Logger,
  ) {
    if (config.EMAIL_TRANSPORT === 'smtp') {
      this.transporter = nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        // Mailpit speaks plaintext SMTP on 1025. A production relay would set
        // secure: true via its own port; this is not a downgrade of a TLS
        // connection, it is the local sink's only protocol.
        secure: false,
        ignoreTLS: config.SMTP_PORT === 1025,
      });
    }
  }

  onModuleDestroy(): void {
    this.transporter?.close();
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      switch (this.config.EMAIL_TRANSPORT) {
        case 'noop':
          return;

        case 'console':
          this.sent.push(message);
          this.logger.info(
            { event: 'email.rendered', to: message.to, subject: message.subject },
            'Email rendered (console transport)',
          );
          return;

        case 'smtp':
          this.sent.push(message);
          await this.transporter?.sendMail({
            from: this.config.EMAIL_FROM,
            to: message.to,
            subject: message.subject,
            text: message.text,
            ...(message.html ? { html: message.html } : {}),
          });
          this.logger.info(
            { event: 'email.sent', to: message.to, subject: message.subject },
            'Email sent',
          );
      }
    } catch (error) {
      // Logged, never rethrown — see the class comment on why a mail failure
      // must not undo a committed invitation.
      this.logger.error(
        { event: 'email.send_failed', to: message.to, err: error },
        'Failed to send email',
      );
    }
  }

  /** Test helper; only meaningful under the console and smtp transports. */
  clearSent(): void {
    this.sent.length = 0;
  }
}
