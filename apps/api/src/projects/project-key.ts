import { createHash, randomBytes } from 'node:crypto';

export interface ProjectKeyMaterial {
  key: string;
  keyPrefix: string;
  keyHash: string;
}

export function createProjectKeyMaterial(): ProjectKeyMaterial {
  const key = `tr_${randomBytes(32).toString('base64url')}`;
  if (!/^tr_[A-Za-z0-9_-]{43}$/.test(key)) {
    throw new Error('Secure project key generation failed');
  }
  return {
    key,
    keyPrefix: key.slice(0, 11),
    keyHash: createHash('sha256').update(key, 'utf8').digest('hex'),
  };
}
