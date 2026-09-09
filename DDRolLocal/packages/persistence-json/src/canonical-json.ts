import crypto from 'node:crypto';
export { canonicalJson } from '@nyx/domain';

export function sha256(value: string | Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
