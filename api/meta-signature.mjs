import { createHmac } from 'node:crypto';
import { tokensMatch } from './auth.mjs';

export function signHubBody(rawBody, secret) {
  const hex = createHmac('sha256', secret).update(rawBody).digest('hex');
  return `sha256=${hex}`;
}

export function verifyHubSignature(rawBody, header, secret) {
  const received = Array.isArray(header) ? (header[0] || '') : (header || '');
  return tokensMatch(received, signHubBody(rawBody, secret));
}
