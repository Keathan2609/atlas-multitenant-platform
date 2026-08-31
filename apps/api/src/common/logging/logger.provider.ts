import { type Provider } from '@nestjs/common';
import { createLogger, type Logger } from '@atlas/observability';
import { CONFIG_TOKEN } from '../../config/env.js';
import type { AppConfig } from '../../config/env.js';

export const LOGGER_TOKEN = Symbol('ATLAS_LOGGER');

export const loggerProvider: Provider = {
  provide: LOGGER_TOKEN,
  inject: [CONFIG_TOKEN],
  useFactory: (config: AppConfig): Logger =>
    createLogger({
      level: config.LOG_LEVEL,
      format: config.LOG_FORMAT,
      service: 'atlas-api',
      environment: config.NODE_ENV,
    }),
};
