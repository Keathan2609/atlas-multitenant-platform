import { Module } from '@nestjs/common';
import { InvitationsController, InvitationRedemptionController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';

@Module({
  controllers: [InvitationsController, InvitationRedemptionController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
