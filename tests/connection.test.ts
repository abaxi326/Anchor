import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { connect as connectSocket, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Server as SshServer, utils, type Connection, type ParsedKey } from 'ssh2';
import { SshConnection } from '../src/connection/ssh';
import { HttpConnection } from '../src/connection/http';
import { normalizeBaseUrl, validateProfile } from '../src/connection/validation';
import { DEFAULT_PROFILE } from '../src/shared';

const hostKey = utils.generateKeyPairSync('ed25519');
const passphrase = 'test-key-passphrase';
const clientKey = utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-cbc', rounds: 1 });
function parseKey(key: string, password?: string): ParsedKey {
  const parsed = utils.parseKey(key, password);
  assert(!(parsed instanceof Error));
  return parsed;
}
const parsedClient = parseKey(clientKey.private, passphrase);
const parsedHost = parseKey(hostKey.private);
const expectedFingerprint = `SHA256:${createHash('sha256').update(parsedHost.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'open-anchor-ssh-'));
  const keyPath = join(directory, 'id_ed25519');
  await writeFile(keyPath, clientKey.private);
  const connections = new Set<Connection>();
  const sockets = new Set<Socket>();
  const forwards: Array<{ host: string; port: number }> = [];
  const requests: Array<{ path: string; authorization?: string }> = [];
  let models = ['test-model'];
  let statusCode = 200;
  let stall = false;
  let authAttempts = 0;
  let remoteCommands = 0;
  let onRequest: (() => void) | undefined;
  const api = createHttpServer((req, res) => {
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization });
    onRequest?.();
    if (stall) return;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/v1/models'
      ? { data: models.map(id => ({ id })) } : { choices: [{ message: { content: 'tunnel works' } }] }));
  });
  api.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const remotePort = (api.address() as AddressInfo).port;

  const ssh = new SshServer({ hostKeys: [hostKey.private] }, connection => {
    connections.add(connection);
    connection.on('error', () => {});
    connection.once('close', () => connections.delete(connection));
    connection.on('authentication', ctx => {
      ++authAttempts;
      if (ctx.method !== 'publickey' || ctx.username !== 'root' || !ctx.key.data.equals(parsedClient.getPublicSSH())) {
        ctx.reject(); return;
      }
      if (ctx.signature && !parsedClient.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) { ctx.reject(); return; }
      ctx.accept();
    });
    connection.on('session', (_accept, reject) => { ++remoteCommands; reject(); });
    connection.on('tcpip', (accept, reject, info) => {
      forwards.push({ host: info.destIP, port: info.destPort });
      if (info.destIP !== '127.0.0.1' || info.destPort !== remotePort) { reject(); return; }
      const channel = accept();
      const socket = connectSocket(remotePort, '127.0.0.1');
      sockets.add(socket);
      channel.on('error', () => socket.destroy());
      socket.on('error', () => channel.destroy());
      socket.once('close', () => { sockets.delete(socket); channel.destroy(); });
      channel.once('close', () => socket.destroy());
      channel.pipe(socket).pipe(channel);
    });
  });
  ssh.listen(0, '127.0.0.1');
  await once(ssh, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const connection of connections) connection.end();
    await Promise.all([
      new Promise<void>(resolve => api.close(() => resolve())),
      new Promise<void>(resolve => ssh.close(() => resolve())),
    ]);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    profile: { ...DEFAULT_PROFILE, transport: 'ssh' as const, host: '127.0.0.1', port: (ssh.address() as AddressInfo).port, privateKeyPath: keyPath, remotePort },
    connections, forwards, requests,
    setModels: (value: string[]) => { models = value; },
    setStatus: (value: number) => { statusCode = value; },
    stallRequests: () => { stall = true; },
    requestReceived: () => new Promise<void>(resolve => { onRequest = resolve; }),
    get authAttempts() { return authAttempts; },
    get remoteCommands() { return remoteCommands; },
  };
}

test('connection settings reject unsafe or inconsistent input and apply defaults', () => {
  const valid = { transport: 'ssh', host: 'host.example', privateKeyPath: 'C:\\keys\\vast key' };
  assert.equal(validateProfile(valid).port, 22);
  assert.equal(validateProfile({ ...valid, host: '[::1]' }).host, '::1');
  for (const invalid of [null, [], { ...valid, host: 'https://host.example' },
    { ...valid, host: 'ssh root@host.example' }, { ...valid, port: 0 },
    { ...valid, port: '22' }, { ...valid, remotePort: 65536 },
    { ...valid, model: 'bad\nmodel' }, { ...valid, reasoning: 'true' },
    { ...valid, maxTokens: 32768 }, { ...valid, maxTokens: 255 },
    { ...valid, contextWindow: 4095, maxTokens: 1024 }, { ...valid, privateKeyPath: '' }]) {
    assert.throws(() => validateProfile(invalid));
  }
});

test('accepted host key authenticates encrypted key and forwards HTTP only to remote loopback', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const logs: string[] = [];
  const closes: unknown[] = [];
  const connection = new SshConnection({
    onHostKey: async (host, port, fingerprint) => {
      assert.equal(host, f.profile.host); assert.equal(port, f.profile.port);
      assert.equal(fingerprint, expectedFingerprint); return true;
    },
    onClose: error => closes.push(error), log: message => logs.push(message),
  });
  t.after(() => connection.disconnect());
  const result = await connection.connect(f.profile, { passphrase, apiKey: 'secret-api-key' });
  assert.match(result.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.equal(result.model, 'test-model');
  assert.equal(f.requests[0].authorization, 'Bearer secret-api-key');
  const response = await fetch(`${result.baseUrl}/chat/completions`, { method: 'POST' });
  assert.equal((await response.json() as any).choices[0].message.content, 'tunnel works');
  assert(f.forwards.every(value => value.host === '127.0.0.1' && value.port === f.profile.remotePort));
  assert.equal(f.remoteCommands, 0);
  assert(!logs.join('\n').includes('secret-api-key'));
  assert(!logs.join('\n').includes(passphrase));
  await connection.disconnect();
  assert.equal(closes.length, 0, 'intentional disconnect is not an unexpected closure');
  await assert.rejects(fetch(`${result.baseUrl}/models`));
});

test('denied host key prevents authentication and can be retried', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let accepted = false;
  const connection = new SshConnection({ onHostKey: async () => accepted, onClose: () => {}, log: () => {} });
  t.after(() => connection.disconnect());
  await assert.rejects(connection.connect(f.profile, { passphrase }), /host key was not approved/);
  assert.equal(f.authAttempts, 0);
  assert.equal(f.forwards.length, 0);
  accepted = true;
  assert.equal((await connection.connect(f.profile, { passphrase })).model, 'test-model');
});

test('model readiness handles authorization, ambiguity, and explicit model selection', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const connection = new SshConnection({ onHostKey: async () => true, onClose: () => {}, log: () => {} });
  t.after(() => connection.disconnect());
  f.setStatus(401);
  await assert.rejects(connection.connect(f.profile, { passphrase }), /rejected the API key/);
  f.setStatus(200);
  f.setModels(['one', 'two']);
  await assert.rejects(connection.connect(f.profile, { passphrase }), /multiple models/);
  await assert.rejects(connection.connect({ ...f.profile, model: 'missing' }, { passphrase }), /not advertised/);
  assert.equal((await connection.connect({ ...f.profile, model: 'two' }, { passphrase })).model, 'two');
});

test('host-key mismatch preserves trusted callback instructions and rejected authentication is actionable', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let rejectKey = true;
  const connection = new SshConnection({
    onHostKey: async () => {
      if (rejectKey) throw new Error('SSH host key changed. Verify the server before resetting trust.');
      return true;
    }, onClose: () => {}, log: () => {},
  });
  t.after(() => connection.disconnect());
  await assert.rejects(connection.connect(f.profile, { passphrase }), /host key changed.*resetting trust/);
  assert.equal(f.authAttempts, 0);
  rejectKey = false;
  await assert.rejects(connection.connect({ ...f.profile, username: 'invalid-user' }, { passphrase }), /authentication failed/);
  assert.equal(f.forwards.length, 0);
});

test('wrong key passphrase fails without exposing it and supports a later valid connection', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const connection = new SshConnection({ onHostKey: async () => true, onClose: () => {}, log: () => {} });
  t.after(() => connection.disconnect());
  await assert.rejects(connection.connect(f.profile, { passphrase: 'incorrect-secret' }), (error: Error) => {
    assert.match(error.message, /private-key format and passphrase/);
    assert(!error.message.includes('incorrect-secret')); return true;
  });
  assert.equal((await connection.connect(f.profile, { passphrase })).model, 'test-model');
});

test('cancellation while host-key approval is pending closes the attempt and allows retry', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let approvalReached!: () => void;
  const approval = new Promise<void>(resolve => { approvalReached = resolve; });
  let approve!: (value: boolean) => void;
  let first = true;
  const connection = new SshConnection({
    onHostKey: async () => {
      if (!first) return true;
      first = false; approvalReached();
      return new Promise<boolean>(resolve => { approve = resolve; });
    }, onClose: () => {}, log: () => {},
  });
  t.after(() => connection.disconnect());
  const controller = new AbortController();
  const pending = connection.connect(f.profile, { passphrase }, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await approval;
  controller.abort();
  await rejected;
  approve(true);
  assert.equal((await connection.connect(f.profile, { passphrase })).model, 'test-model');
});

test('disconnect cancels a stalled model readiness request', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.stallRequests();
  const received = f.requestReceived();
  const connection = new SshConnection({ onHostKey: async () => true, onClose: () => {}, log: () => {} });
  t.after(() => connection.disconnect());
  const pending = connection.connect(f.profile, { passphrase });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await received;
  await connection.disconnect();
  await rejected;
});

test('unexpected SSH closure reports once and closes the local listening port', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let closed!: () => void;
  const notified = new Promise<void>(resolve => { closed = resolve; });
  let count = 0;
  const connection = new SshConnection({
    onHostKey: async () => true, onClose: error => { assert(error); ++count; closed(); }, log: () => {},
  });
  t.after(() => connection.disconnect());
  const { baseUrl } = await connection.connect(f.profile, { passphrase });
  for (const client of f.connections) client.end();
  await notified;
  await assert.rejects(fetch(`${baseUrl}/models`));
  await connection.disconnect();
  assert.equal(count, 1);
});

async function directFixture(t: TestContext) {
  let status = 200;
  let payload = JSON.stringify({ data: [{ id: 'direct-model' }] });
  let redirect = '';
  let stalled = false;
  let received: (() => void) | undefined;
  const requests: Array<{ path: string; authorization?: string }> = [];
  const sockets = new Set<Socket>();
  const server = createHttpServer((req, res) => {
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization });
    received?.();
    if (stalled) return;
    res.writeHead(status, { 'Content-Type': 'application/json', ...(redirect ? { Location: redirect } : {}) });
    res.end(payload);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return {
    profile: { ...DEFAULT_PROFILE, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
    requests,
    respond: (code: number, body: string, location = '') => { status = code; payload = body; redirect = location; },
    stall: () => { stalled = true; },
    received: () => new Promise<void>(resolve => { received = resolve; }),
  };
}

test('direct URL validation accepts proxy prefixes and addresses without SSH settings', () => {
  for (const [input, expected] of [
    ['http://127.0.0.1:8000', 'http://127.0.0.1:8000/v1'],
    ['127.0.0.1:8000', 'http://127.0.0.1:8000/v1'],
    ['host.example:18000', 'http://host.example:18000/v1'],
    ['https://vast-proxy.example', 'https://vast-proxy.example/v1'],
    ['https://vast-proxy.example/proxy/8000/v1/', 'https://vast-proxy.example/proxy/8000/v1'],
    ['https://vast-proxy.example/prefix/', 'https://vast-proxy.example/prefix/v1'],
    ['[::1]:8000', 'http://[::1]:8000/v1'],
  ]) assert.equal(normalizeBaseUrl(input), expected);
  const profile = validateProfile({ baseUrl: '127.0.0.1:8000' });
  assert.equal(profile.transport, 'http');
  assert.equal(profile.privateKeyPath, '');
  assert.equal(profile.host, '');
  const inactiveSsh = validateProfile({ baseUrl: '127.0.0.1:8000', host: undefined, port: NaN, remotePort: 0, username: null, privateKeyPath: 42 });
  assert.equal(inactiveSsh.port, DEFAULT_PROFILE.port);
  assert.equal(inactiveSsh.remotePort, DEFAULT_PROFILE.remotePort);
  assert.equal(inactiveSsh.privateKeyPath, '');
  const inactiveHttp = validateProfile({ transport: 'ssh', host: 'host.example', privateKeyPath: 'key-file', baseUrl: 42 });
  assert.equal(inactiveHttp.baseUrl, '');
  for (const baseUrl of ['', 'ssh://host:22', 'ftp://host', 'https://user:secret@host',
    'https://user@host', 'https://host?token=secret', 'https://host?', 'https://host#',
    'https://host/v1#fragment', 'http://host:65536', 'http://host:0', 'http://host/\\path',
    'http://host with spaces', 'http://host\n/path']) {
    assert.throws(() => validateProfile({ baseUrl }), baseUrl);
  }
  assert.throws(() => validateProfile({ transport: 'unknown', baseUrl: 'host:8000' }));
});

test('direct HTTP discovers an unprotected model and preserves a proxy URL prefix', { timeout: 10000 }, async t => {
  const f = await directFixture(t);
  const connection = new HttpConnection();
  t.after(() => connection.disconnect());
  const result = await connection.connect({ ...f.profile, baseUrl: `${f.profile.baseUrl}/proxy/8000/` }, {});
  assert.equal(result.model, 'direct-model');
  assert.equal(result.baseUrl, `${f.profile.baseUrl}/proxy/8000/v1`);
  assert.equal(f.requests[0].path, '/proxy/8000/v1/models');
  assert.equal(f.requests[0].authorization, undefined);
});

test('direct HTTP supports optional API keys and exact model selection', { timeout: 10000 }, async t => {
  const f = await directFixture(t);
  const logs: string[] = [];
  const connection = new HttpConnection({ log: message => logs.push(message) });
  t.after(() => connection.disconnect());
  f.respond(401, '{}');
  await assert.rejects(connection.connect(f.profile, {}), /rejected the API key/);
  f.respond(200, JSON.stringify({ data: [{ id: 'one' }, { id: 'two' }] }));
  await assert.rejects(connection.connect(f.profile, {}), /multiple models/);
  await assert.rejects(connection.connect({ ...f.profile, model: 'absent' }, {}), /not advertised/);
  const result = await connection.connect({ ...f.profile, model: 'two' }, { apiKey: 'private-api-key' });
  assert.equal(result.model, 'two');
  assert.equal(f.requests.at(-1)?.authorization, 'Bearer private-api-key');
  assert(!logs.join('\n').includes('private-api-key'));
});

test('direct model discovery never follows redirects with credentials', { timeout: 10000 }, async t => {
  const f = await directFixture(t);
  const other = await directFixture(t);
  const connection = new HttpConnection();
  f.respond(302, '', `${other.profile.baseUrl}/v1/models`);
  await assert.rejects(connection.connect(f.profile, { apiKey: 'do-not-forward' }), /redirects elsewhere/);
  assert.equal(f.requests[0].authorization, 'Bearer do-not-forward');
  assert.equal(other.requests.length, 0);
});

test('direct HTTP rejects wrong API routes, malformed responses, and excessive response size', { timeout: 10000 }, async t => {
  const f = await directFixture(t);
  const connection = new HttpConnection();
  f.respond(404, '<html>dashboard</html>');
  await assert.rejects(connection.connect(f.profile, {}), /not found.*SSH port/);
  f.respond(200, '<html>dashboard</html>');
  await assert.rejects(connection.connect(f.profile, {}), /OpenAI-compatible model list/);
  f.respond(200, JSON.stringify({ data: [] }));
  await assert.rejects(connection.connect(f.profile, {}), /did not advertise a model/);
  f.respond(200, 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(connection.connect(f.profile, {}), /oversized model list/);
});

test('direct connection cancellation and disconnect abort in-flight readiness checks', { timeout: 10000 }, async t => {
  const f = await directFixture(t);
  f.stall();
  const connection = new HttpConnection();
  t.after(() => connection.disconnect());
  let received = f.received();
  const controller = new AbortController();
  let pending = connection.connect(f.profile, {}, controller.signal);
  let rejected = assert.rejects(pending, { name: 'AbortError' });
  await received; controller.abort(); await rejected;
  received = f.received();
  pending = connection.connect(f.profile, {});
  rejected = assert.rejects(pending, { name: 'AbortError' });
  await received; await connection.disconnect(); await rejected;
});

test('connecting to an SSH port as HTTP explains which port is needed', { timeout: 10000 }, async t => {
  const sockets = new Set<Socket>();
  const server = createTcpServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.end('SSH-2.0-test-server\r\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const connection = new HttpConnection();
  await assert.rejects(connection.connect({ ...DEFAULT_PROFILE, baseUrl: `127.0.0.1:${(server.address() as AddressInfo).port}` }, {}), /SSH port.*vLLM HTTP port/);
});
