import { ConfigService } from '@nestjs/config';

export function allowPrivateNotificationTargets(config: ConfigService): boolean {
  const environment = config.get<string>('NODE_ENV');
  return (environment === 'development' || environment === 'test')
    && config.get<string>('ALERT_NOTIFICATIONS_ALLOW_PRIVATE_TARGETS') === 'true';
}
