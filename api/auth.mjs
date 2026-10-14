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
  const provided = bearerToken(authorizationHeader);
  const expected = String(expectedToken ?? '');
  if (!provided || !expected.trim()) return false;
  return tokensMatch(provided, expected);
}

export function requireSecret(name, env = process.env) {
  const value = String(env[name] ?? '').trim();
  if (!value) {
    throw new Error(`${name} nao definido.`);
  }
  if (name === 'ADMIN_TOKEN' && value.length < 24) {
    throw new Error('ADMIN_TOKEN precisa ter pelo menos 24 caracteres.');
  }
  return value;
}
