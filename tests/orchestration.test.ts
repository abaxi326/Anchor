import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentClient } from '../src/runtime/client';
import type { WorkerConfig, WorkerEvent } from '../src/shared';

async function workerFixture(t: TestContext, body: string, shutdown = 'process.exit(0)') {
  const directory = await mkdtemp(path.join(tmpdir(), 'open-anchor-client-'));
  const worker = path.join(directory, 'worker.mjs');
  await writeFile(worker, `
    import { createInterface } from 'node:readline';
    const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
    const input = createInterface({ input: process.stdin });
    input.on('line', line => {
      const command = JSON.parse(line);
      if (command.type === 'shutdown') { ${shutdown}; return; }
      if (command.type === 'init') {
        const config = command.config;
        send({ type: 'ready', sessionId: String(process.pid), history: [] });
        ${body}
      }
    });
  `);
  const config: WorkerConfig = {
    cwd: directory, sessionDir: directory, mode: 'plan',
    model: { id: 'test', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'secret-split-across-stderr-chunks', contextWindow: 32768, maxTokens: 8192, reasoning: true },
  };
  return { worker, config, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('runtime client redacts secrets split across stderr chunks', { timeout: 10000 }, async t => {
  const { worker, config, cleanup } = await workerFixture(t, `
    const key = config.model.apiKey;
    process.stderr.write('diagnostic: ' + key.slice(0, 12));
    setTimeout(() => process.stderr.write(key.slice(12) + ' finished\\n'), 50);
  `);
  const logs: string[] = [];
  let finished!: () => void;
  const logged = new Promise<void>(resolve => { finished = resolve; });
  const client = new AgentClient(() => {}, text => {
    logs.push(text);
    if (logs.join('').includes('finished')) finished();
  });
  t.after(async () => { await client.stop(); await cleanup(); });
  await client.start(process.execPath, worker, config);
  await logged;
  assert(!logs.join('').includes(config.model.apiKey), 'stderr must not reveal secrets split at transport chunk boundaries');
  assert(logs.join('').includes('[redacted]'));
});

test('runtime client reports unexpected exit once as fatal and rejects later commands', { timeout: 10000 }, async t => {
  const { worker, config, cleanup } = await workerFixture(t, 'setTimeout(() => process.exit(7), 40);');
  const events: WorkerEvent[] = [];
  let exited!: () => void;
  const exit = new Promise<void>(resolve => { exited = resolve; });
  const client = new AgentClient(event => {
    events.push(event);
    if (event.type === 'error' && event.fatal) exited();
  }, () => {});
  t.after(async () => { await client.stop(); await cleanup(); });
  await client.start(process.execPath, worker, config);
  await exit;
  const errors = events.filter(event => event.type === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].fatal, true);
  assert.match(errors[0].message, /code 7/);
  assert.throws(() => client.send({ type: 'prompt', text: 'after exit' }), /not connected/);
});

test('runtime client intentional shutdown does not report a fatal failure', { timeout: 10000 }, async t => {
  const { worker, config, cleanup } = await workerFixture(t, '');
  const events: WorkerEvent[] = [];
  const client = new AgentClient(event => events.push(event), () => {});
  t.after(async () => { await client.stop(); await cleanup(); });
  await client.start(process.execPath, worker, config);
  await client.stop();
  assert.equal(events.filter(event => event.type === 'error').length, 0);
  assert.throws(() => client.send({ type: 'prompt', text: 'after stop' }), /not connected/);
});

test('runtime client force-stops an uncooperative worker and waits for its exit', { timeout: 12000 }, async t => {
  const { worker, config, cleanup } = await workerFixture(t, "process.on('SIGTERM', () => {});", '');
  let pid: number | undefined;
  const events: WorkerEvent[] = [];
  const client = new AgentClient(event => {
    events.push(event);
    if (event.type === 'ready') pid = Number(event.sessionId);
  }, () => {});
  t.after(async () => { await client.stop(); await cleanup(); });
  await client.start(process.execPath, worker, config);
  assert(pid);
  await client.stop();
  assert.throws(() => process.kill(pid!, 0), 'stop must wait until the process is gone');
  assert.equal(events.filter(event => event.type === 'error').length, 0);
});
