import { Global, Module } from '@nestjs/common';
import { ApiKeysController } from './api-keys.controller.js';
import { ApiKeysService } from './api-keys.service.js';
import { ApiKeyGuard } from './api-key.guard.js';

/**
 * Global because ApiKeyGuard is registered as an APP_GUARD in AppModule and
 * therefore resolves from the root injector, where it needs ApiKeysService.
 */
@Global()
@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeysService, ApiKeyGuard],
  exports: [ApiKeysService, ApiKeyGuard],
})
export class ApiKeysModule {}
