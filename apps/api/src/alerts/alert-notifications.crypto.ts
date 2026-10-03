import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

export function notificationEncryptionKey(config: ConfigService): Buffer {
  const encoded = config.get<string>('ALERT_NOTIFICATION_ENCRYPTION_KEY');
  if (typeof encoded !== 'string' || encoded.length === 0) throw new Error('Notification encryption is not configured');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('Notification encryption is not configured');
  return key;
}

export function encryptNotificationTarget(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptNotificationTarget(value: string, key: Buffer): string {
  const [version, ivText, tagText, encryptedText, extra] = value.split('.');
  if (version !== VERSION || !ivText || !tagText || encryptedText === undefined || extra !== undefined) {
    throw new Error('Notification target cannot be decrypted');
  }
  const iv = Buffer.from(ivText, 'base64');
  const tag = Buffer.from(tagText, 'base64');
  const encrypted = Buffer.from(encryptedText, 'base64');
  if (iv.length !== 12 || tag.length !== 16 || iv.toString('base64') !== ivText || tag.toString('base64') !== tagText
    || encrypted.toString('base64') !== encryptedText) throw new Error('Notification target cannot be decrypted');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function notificationDestinationHint(type: 'webhook' | 'email', target: string): string {
  if (type === 'email') {
    const [local = '', domain = ''] = target.split('@');
    return `${local.slice(0, 1)}•••@${domain}`;
  }
  const url = new URL(target);
  return `${url.protocol}//${url.host}/…`;
}
