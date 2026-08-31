import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service.js';

/** Global: invitations need it today, notifications will tomorrow. */
@Global()
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
