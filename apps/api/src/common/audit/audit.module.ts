import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/**
 * Global because nearly every domain module records events, and threading an
 * import through each one would be ceremony without encapsulation value.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
