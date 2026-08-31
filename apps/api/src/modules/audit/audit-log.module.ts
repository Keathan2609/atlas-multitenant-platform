import { Module } from '@nestjs/common';
import { AuditLogController } from './audit-log.controller.js';
import { AuditLogService } from './audit-log.service.js';

@Module({
  controllers: [AuditLogController],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
