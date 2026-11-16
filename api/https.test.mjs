import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const token = 'abcdefghijklmnopqrstuvwx';

function pedir(protocolo, port, method, path, body = '') {
  const enviar = protocolo === 'https' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = enviar({
      host: '127.0.0.1',
      port,
      method,
      path,
      rejectUnauthorized: false,
      headers: body
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode, texto: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('HTTPS nao serve interno nem POST /atendimentos; o HTTP continua', async (t) => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('openssl nao esta no PATH; o certificado local nao foi gerado e as assercoes de HTTPS nao rodaram');
      return;
    }
  }
  const diretorio = await mkdtemp(join(tmpdir(), 'ingressos-https-'));
  const cert = join(diretorio, 'cert.pem');
  const key = join(diretorio, 'key.pem');
  const config = join(diretorio, 'openssl.cnf');
  writeFileSync(config, [
    '[req]',
    'distinguished_name = dn',
    'x509_extensions = v3',
    'prompt = no',
    '[dn]',
    'CN = 127.0.0.1',
    '[v3]',
    'subjectAltName = IP:127.0.0.1',
    '',
  ].join('\n'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
    '-days', '1', '-nodes', '-config', config,
  ], { stdio: 'ignore', env: { ...process.env, OPENSSL_CONF: config } });
  const httpPort = 20000 + Math.floor(Math.random() * 10000);
  const httpsPort = httpPort + 1;
  let stdout = '';
  const child = spawn(process.execPath, ['api/server.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ADMIN_TOKEN: token,
      API_INTERNAL_TOKEN: token,
      API_HOST: '127.0.0.1',
      API_PORT: String(httpPort),
      API_DATABASE_PATH: join(diretorio, 'teste.sqlite'),
      API_TLS_CERT_PATH: cert,
      API_TLS_KEY_PATH: key,
      API_HTTPS_PORT: String(httpsPort),
    },
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => {});
  const started = Date.now();
  try {
    while (Date.now() - started < 8000) {
      if (child.exitCode !== null) throw new Error('A API encerrou.');
      if (stdout.includes(`https://127.0.0.1:${httpsPort}`)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(stdout, new RegExp(`https://127\\.0\\.0\\.1:${httpsPort}`));
    const interno = await pedir('https', httpsPort, 'POST', '/interno/mensagem', '{}');
    const atendimento = await pedir('https', httpsPort, 'POST', '/atendimentos', '{}');
    const httpAtendimento = await pedir('http', httpPort, 'POST', '/atendimentos', '{}');
    const httpInterno = await pedir('http', httpPort, 'POST', '/interno/mensagem', '{}');
    assert.equal(interno.status, 404);
    assert.equal(atendimento.status, 404);
    assert.equal(httpAtendimento.status, 400);
    assert.equal(httpInterno.status, 401);
  } finally {
    child.kill();
    await new Promise((resolve) => child.on('exit', resolve));
    await rm(diretorio, { recursive: true, force: true });
  }
});
