import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import type { WorkerCommand, WorkerConfig, WorkerEvent } from '../src/shared';

let artifacts: string;
let workerFile: string;

before(async () => {
  const base = path.resolve('.test-artifacts');
  await mkdir(base, { recursive: true });
  artifacts = await mkdtemp(path.join(base, 'agent-'));
  workerFile = path.join(artifacts, 'worker.mjs');
  await build({ entryPoints: ['src/agent/worker.ts'], outfile: workerFile, platform: 'node', format: 'esm', packages: 'external', bundle: true, target: 'es2022' });
});
after(async () => { if (artifacts) await rm(artifacts, { recursive: true, force: true }); });

type Request = { messages: Array<Record<string, any>>; tools?: Array<{ function: { name: string } }>; [key: string]: any };
type Reply = { tool: string; args: Record<string, unknown> } | { text: string };

async function mockModel(replies: Reply[], apiPath = '/v1') {
  const requests: Request[] = [];
  const headers: Array<string | undefined> = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    if (req.url !== `${apiPath}/chat/completions`) { res.writeHead(404).end(); return; }
    headers.push(req.headers.authorization);
    const input = JSON.parse(body) as Request;
    requests.push(input);
    const next = replies.shift() ?? { text: 'Done.' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta: object, finish: string | null = null) => {
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'qwen-test', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    };
    if ('tool' in next) {
      chunk({ role: 'assistant', reasoning_content: 'Checking the task.' });
      chunk({ tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: next.tool, arguments: JSON.stringify(next.args) } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({ role: 'assistant', content: next.text.slice(0, 3) });
      chunk({ content: next.text.slice(3) });
      chunk({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    requests, headers, replies, baseUrl: `http://127.0.0.1:${address.port}${apiPath}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

class Worker {
  readonly process: ChildProcessWithoutNullStreams;
  readonly events: WorkerEvent[] = [];
  private waiting = new Set<() => void>();
  stderr = '';

  constructor() {
    this.process = spawn(process.execPath, [workerFile], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stderr.on('data', (data) => { this.stderr += data; });
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      this.events.push(JSON.parse(line) as WorkerEvent);
      for (const callback of this.waiting) callback();
    });
  }

  send(command: WorkerCommand): void { this.process.stdin.write(`${JSON.stringify(command)}\n`); }

  wait<T extends WorkerEvent['type']>(type: T, after = 0): Promise<Extract<WorkerEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}: ${this.stderr}\n${JSON.stringify(this.events)}`)); }, 60000);
      const cleanup = () => { clearTimeout(timer); this.waiting.delete(check); };
      const check = () => {
        const event = this.events.slice(after).find((item) => item.type === type);
        if (event) { cleanup(); resolve(event as Extract<WorkerEvent, { type: T }>); }
        else if (type === 'ready') {
          const error = this.events.slice(after).find((item) => item.type === 'error');
          if (error?.type === 'error') { cleanup(); reject(new Error(error.message)); }
        }
      };
      this.waiting.add(check);
      check();
    });
  }

  async close(): Promise<void> {
    if (this.process.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => this.process.once('exit', () => resolve()));
    this.send({ type: 'shutdown' });
    const timer = setTimeout(() => this.process.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
}

async function fixture(baseUrl: string, mode: WorkerConfig['mode'] = 'agent') {
  const dir = await mkdtemp(path.join(artifacts, 'case-'));
  const cwd = path.join(dir, 'workspace');
  const sessionDir = path.join(dir, 'sessions');
  await mkdir(cwd);
  const config: WorkerConfig = {
    cwd, sessionDir, mode,
    model: { id: 'qwen-test', baseUrl, apiKey: 'private-test-key', contextWindow: 32768, maxTokens: 4096, reasoning: true },
  };
  const worker = new Worker();
  return { config, worker, cwd, sessionDir };
}

test('real worker uses Pi read tools, streams text, preserves Qwen reasoning and ignores executable project resources', async () => {
  const model = await mockModel([{ tool: 'read', args: { path: 'hello.txt' } }, { text: 'Read complete.' }]);
  const { worker, config, cwd, sessionDir } = await fixture(model.baseUrl, 'plan');
  try {
    await writeFile(path.join(cwd, 'hello.txt'), 'workspace contents');
    await writeFile(path.join(cwd, 'AGENTS.md'), 'REPO_RULE_SENTINEL: use existing project conventions.');
    await mkdir(path.join(cwd, '.pi', 'extensions'), { recursive: true });
    await writeFile(path.join(cwd, '.pi', 'extensions', 'untrusted.ts'), 'throw new Error("UNTRUSTED_EXTENSION_EXECUTED");');
    worker.send({ type: 'init', config });
    await worker.wait('ready');
    worker.send({ type: 'prompt', text: 'Read hello.txt.' });
    await worker.wait('idle');
    assert.equal(worker.events.filter((event) => event.type === 'text').map((event) => event.text).join(''), 'Read complete.');
    assert(worker.events.some((event) => event.type === 'toolEnd' && event.text.includes('workspace contents') && !event.isError));
    assert(!worker.events.some((event) => event.type === 'approval' || event.type === 'error'));
    assert.deepEqual(model.requests[0].tools?.map((tool) => tool.function.name).sort(), ['find', 'grep', 'ls', 'read']);
    assert(JSON.stringify(model.requests[0].messages).includes('REPO_RULE_SENTINEL'));
    assert.deepEqual(model.requests[0].chat_template_kwargs, { enable_thinking: true, preserve_thinking: true });
    assert.equal(model.requests[0].max_tokens, 4096);
    assert.equal(model.requests[0].reasoning_effort, undefined);
    assert.equal(model.headers[0], 'Bearer private-test-key');
    const replayedAssistant = model.requests[1].messages.find((message) => message.role === 'assistant' && message.tool_calls);
    assert.equal(replayedAssistant?.reasoning_content, 'Checking the task.');
    for (const name of await readdir(sessionDir)) {
      if (name.endsWith('.jsonl')) assert(!(await readFile(path.join(sessionDir, name), 'utf8')).includes('private-test-key'));
    }
  } finally { await worker.close(); await model.close(); }
});

test('direct inference preserves a proxy API prefix and works without an API key', async () => {
  const model = await mockModel([{ text: 'Direct inference complete.' }], '/proxy/8000/v1');
  const { worker, config } = await fixture(`${model.baseUrl}/`, 'plan');
  try {
    worker.send({ type: 'init', config: { ...config, model: { ...config.model, apiKey: '' } } });
    await worker.wait('ready');
    worker.send({ type: 'prompt', text: 'Reply through the direct API.' });
    await worker.wait('idle');
    assert.equal(worker.events.filter((event) => event.type === 'text').map((event) => event.text).join(''), 'Direct inference complete.');
    assert.equal(model.requests.length, 1);
    assert.equal(model.headers[0], undefined);
    assert(!worker.events.some((event) => event.type === 'error'));
  } finally { await worker.close(); await model.close(); }
});

test('write waits for matching approval; resumed session restores history without executing tools', async () => {
  const model = await mockModel([{ tool: 'write', args: { path: 'created.txt', content: 'approved content' } }, { text: 'Created.' }]);
  const { worker, config, cwd } = await fixture(model.baseUrl);
  let resume: Worker | undefined;
  try {
    worker.send({ type: 'init', config });
    const ready = await worker.wait('ready');
    worker.send({ type: 'prompt', text: 'Create created.txt.' });
    const approval = await worker.wait('approval');
    assert.equal(approval.request.id, 'call_1');
    assert.equal(approval.request.input.path, path.join(cwd, 'created.txt'));
    await assert.rejects(readFile(path.join(cwd, 'created.txt')), { code: 'ENOENT' });
    worker.send({ type: 'approval', id: 'unrelated', approved: true });
    await assert.rejects(readFile(path.join(cwd, 'created.txt')), { code: 'ENOENT' });
    worker.send({ type: 'approval', id: approval.request.id, approved: true });
    await worker.wait('idle');
    assert.equal(await readFile(path.join(cwd, 'created.txt'), 'utf8'), 'approved content');
    assert(worker.events.some((event) => event.type === 'toolEnd' && event.id === approval.request.id && !event.isError));
    await worker.close();
    const previousRequests = model.requests.length;
    resume = new Worker();
    resume.send({ type: 'init', config: { ...config, sessionFile: ready.sessionFile } });
    const restored = await resume.wait('ready');
    assert.equal(restored.sessionId, ready.sessionId);
    assert(restored.history.some((entry) => entry.role === 'user' && entry.text === 'Create created.txt.'));
    assert(restored.history.some((entry) => entry.role === 'assistant' && entry.text === 'Created.'));
    assert.equal(model.requests.length, previousRequests);
    assert(!resume.events.some((event) => event.type === 'toolStart' || event.type === 'approval'));
  } finally { await worker.close(); await resume?.close(); await model.close(); }
});

test('denied and cancelled approvals never execute the pending write', async () => {
  const model = await mockModel([{ tool: 'write', args: { path: 'denied.txt', content: 'bad' } }, { text: 'Denied.' }, { tool: 'write', args: { path: 'cancelled.txt', content: 'bad' } }]);
  const { worker, config, cwd } = await fixture(model.baseUrl);
  try {
    worker.send({ type: 'init', config }); await worker.wait('ready');
    worker.send({ type: 'prompt', text: 'Try a write.' });
    const first = await worker.wait('approval');
    worker.send({ type: 'approval', id: first.request.id, approved: false });
    await worker.wait('idle');
    await assert.rejects(readFile(path.join(cwd, 'denied.txt')), { code: 'ENOENT' });
    assert(worker.events.some((event) => event.type === 'toolEnd' && event.isError && event.text.includes('denied')));
    const offset = worker.events.length;
    worker.send({ type: 'prompt', text: 'Try another write.' });
    const second = await worker.wait('approval', offset);
    worker.send({ type: 'abort' });
    await worker.wait('idle', offset);
    worker.send({ type: 'approval', id: second.request.id, approved: true });
    await assert.rejects(readFile(path.join(cwd, 'cancelled.txt')), { code: 'ENOENT' });
  } finally { await worker.close(); await model.close(); }
});

test('Plan mode rejects an unadvertised write and can switch to Agent while idle', async () => {
  const model = await mockModel([{ tool: 'write', args: { path: 'unexpected.txt', content: 'bad' } }, { text: 'Cannot write in plan mode.' }, { tool: 'write', args: { path: 'allowed.txt', content: 'ok' } }, { text: 'Done.' }]);
  const { worker, config, cwd } = await fixture(model.baseUrl, 'plan');
  try {
    worker.send({ type: 'init', config }); await worker.wait('ready');
    worker.send({ type: 'prompt', text: 'Plan a change.' }); await worker.wait('idle');
    assert(!worker.events.some((event) => event.type === 'approval'));
    await assert.rejects(readFile(path.join(cwd, 'unexpected.txt')), { code: 'ENOENT' });
    const offset = worker.events.length;
    worker.send({ type: 'mode', mode: 'agent' });
    worker.send({ type: 'prompt', text: 'Implement it.' });
    const approval = await worker.wait('approval', offset);
    worker.send({ type: 'approval', id: approval.request.id, approved: true });
    await worker.wait('idle', offset);
    assert.equal(await readFile(path.join(cwd, 'allowed.txt'), 'utf8'), 'ok');
  } finally { await worker.close(); await model.close(); }
});

test('approved platform shell uses the actual Pi shell tool', async () => {
  const tool = process.platform === 'win32' ? 'powershell' : 'bash';
  const command = process.platform === 'win32' ? "Write-Output 'anchor-shell-check'" : "printf 'anchor-shell-check'";
  const model = await mockModel([{ tool, args: { command } }, { text: 'Command complete.' }]);
  const { worker, config } = await fixture(model.baseUrl);
  try {
    worker.send({ type: 'init', config }); await worker.wait('ready');
    worker.send({ type: 'prompt', text: 'Run the shell check.' });
    const approval = await worker.wait('approval');
    assert.equal(approval.request.toolName, tool);
    assert.equal(approval.request.input.command, command);
    worker.send({ type: 'approval', id: approval.request.id, approved: true });
    await worker.wait('idle');
    assert(worker.events.some((event) => event.type === 'toolEnd' && !event.isError && event.text.includes('anchor-shell-check')));
  } finally { await worker.close(); await model.close(); }
});

test('precise edits use Pi schema, outside reads fail, and disabled reasoning is explicit', async () => {
  const model = await mockModel([
    { tool: 'read', args: { path: '../outside.txt' } },
    { tool: 'edit', args: { path: 'code.ts', edits: [{ oldText: 'return 1', newText: 'return 2' }] } },
    { text: 'Edited.' },
  ]);
  const { worker, config, cwd } = await fixture(model.baseUrl);
  try {
    await writeFile(path.join(cwd, 'code.ts'), 'function answer() { return 1; }');
    await writeFile(path.join(cwd, '..', 'outside.txt'), 'OUTSIDE_FILE_SENTINEL');
    worker.send({ type: 'init', config: { ...config, model: { ...config.model, reasoning: false } } });
    await worker.wait('ready');
    worker.send({ type: 'prompt', text: 'Inspect and update the answer.' });
    const approval = await worker.wait('approval');
    assert.equal(approval.request.toolName, 'edit');
    assert(worker.events.some((event) => event.type === 'toolEnd' && event.toolName === 'read' && event.isError));
    assert(!JSON.stringify(model.requests).includes('OUTSIDE_FILE_SENTINEL'));
    assert.equal(await readFile(path.join(cwd, 'code.ts'), 'utf8'), 'function answer() { return 1; }');
    worker.send({ type: 'approval', id: approval.request.id, approved: true });
    await worker.wait('idle');
    assert.equal(await readFile(path.join(cwd, 'code.ts'), 'utf8'), 'function answer() { return 2; }');
    assert.deepEqual(model.requests[0].chat_template_kwargs, { enable_thinking: false, preserve_thinking: true });
    assert(!worker.events.some((event) => event.type === 'error'));
  } finally { await worker.close(); await model.close(); }
});
