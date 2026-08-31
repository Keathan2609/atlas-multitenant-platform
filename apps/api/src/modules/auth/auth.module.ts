import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { AuthGuard } from './auth.guard.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, PasswordService, SessionService, AuthGuard],
  exports: [AuthService, SessionService, PasswordService, AuthGuard],
})
export class AuthModule {}
