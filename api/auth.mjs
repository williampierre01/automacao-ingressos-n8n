import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest();
}

export function tokensMatch(provided, expected) {
  return timingSafeEqual(sha256(provided), sha256(expected));
}

export function bearerToken(authorizationHeader) {
  const header = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : '';
}

export function adminAuthorized(authorizationHeader, expectedToken) {
  return tokensMatch(bearerToken(authorizationHeader), expectedToken);
}

export function requireSecret(name, env = process.env) {
  const value = String(env[name] ?? '').trim();
  if (!value) {
    throw new Error(`${name} nao definido.`);
  }
  return value;
}
