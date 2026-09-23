// Run against an extracted VSIX's extension directory. No dev dependencies required.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

if (!process.argv[2]) throw new Error('Usage: node scripts/smoke-package.mjs <extracted-extension-directory>');
const extensionRoot = await realpath(process.argv[2]);
const workerFile = path.join(extensionRoot, 'dist', 'worker.mjs');
const fixture = await mkdtemp(path.join(tmpdir(), 'open-anchor-package-'));
const cwd = path.join(fixture, 'workspace');
await mkdir(cwd);
await writeFile(path.join(cwd, 'hello.txt'), 'packaged-read-sentinel');

// An extraction under the repository can otherwise silently resolve omitted packages
// from the development node_modules. Reject that fallback at module resolution.
const guard = `import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = ${JSON.stringify(extensionRoot)};
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (result.url.startsWith('file:')) {
    const relative = path.relative(root, fileURLToPath(result.url));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      throw new Error('Packaged worker resolved outside its extension: ' + result.url);
  }
  return result;
} });`;

const requests = [];
const server = createServer(async (request, response) => {
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  let body = '';
  for await (const part of request) body += part;
  requests.push(JSON.parse(body));
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta, finish = null) => response.write(`data: ${JSON.stringify({
    id: 'package-smoke', object: 'chat.completion.chunk', created: 1, model: 'qwen-package-test',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`);
  if (requests.length <= 2) {
    const tool = requests.length === 1 ? 'read' : 'write';
    const args = tool === 'read' ? { path: 'hello.txt' } : { path: 'created.txt', content: 'packaged-write-sentinel' };
    chunk({ role: 'assistant', reasoning_content: 'Checking the packaged tool.' });
    chunk({ tool_calls: [{ index: 0, id: `package_call_${requests.length}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] });
    chunk({}, 'tool_calls');
  } else {
    chunk({ role: 'assistant', content: 'Packaged worker complete.' });
    chunk({}, 'stop');
  }
  response.end('data: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const worker = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(guard)}`, workerFile], {
  cwd: fixture, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
const events = [];
const listeners = new Set();
let stderr = '';
let failure;
worker.stderr.on('data', (data) => { stderr += data; });
worker.on('error', (error) => { failure = error; for (const listener of listeners) listener(); });
worker.on('exit', (code) => {
  failure ??= new Error(`Worker exited (${code}): ${stderr}`);
  for (const listener of listeners) listener();
});
createInterface({ input: worker.stdout }).on('line', (line) => {
  try { events.push(JSON.parse(line)); }
  catch { failure = new Error(`Worker emitted invalid JSON: ${line}`); }
  for (const listener of listeners) listener();
});
const send = (command) => worker.stdin.write(`${JSON.stringify(command)}\n`);
const wait = (type) => new Promise((resolve, reject) => {
  const cleanup = () => { clearTimeout(timer); listeners.delete(check); };
  const check = () => {
    const error = failure ?? events.find((event) => event.type === 'error');
    if (error) { cleanup(); reject(new Error(error.message)); return; }
    const event = events.find((item) => item.type === type);
    if (event) { cleanup(); resolve(event); }
  };
  const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}: ${stderr}`)); }, 60000);
  listeners.add(check);
  check();
});

try {
  send({ type: 'init', config: {
    cwd, sessionDir: path.join(fixture, 'sessions'), mode: 'agent',
    model: { id: 'qwen-package-test', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'package-test-key', contextWindow: 32768, maxTokens: 4096, reasoning: true },
  } });
  await wait('ready');
  send({ type: 'prompt', text: 'Read hello.txt and create created.txt.' });
  const approval = await wait('approval');
  assert.equal(approval.request.toolName, 'write');
  await assert.rejects(readFile(path.join(cwd, 'created.txt')), { code: 'ENOENT' });
  send({ type: 'approval', id: approval.request.id, approved: true });
  await wait('idle');
  assert(events.some((event) => event.type === 'toolEnd' && event.toolName === 'read' && !event.isError && event.text.includes('packaged-read-sentinel')));
  assert(events.some((event) => event.type === 'toolEnd' && event.id === approval.request.id && !event.isError));
  assert.equal(await readFile(path.join(cwd, 'created.txt'), 'utf8'), 'packaged-write-sentinel');
  assert.equal(events.filter((event) => event.type === 'text').map((event) => event.text).join(''), 'Packaged worker complete.');
  assert.equal(requests.length, 3);
  assert.equal(requests[1].messages.find((message) => message.role === 'assistant' && message.tool_calls)?.reasoning_content, 'Checking the packaged tool.');
  console.log('Packaged Pi worker passed: isolated module resolution, streaming, Qwen reasoning replay, read, approval, and write.');
} finally {
  if (worker.exitCode === null && worker.signalCode === null) {
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    send({ type: 'shutdown' });
    const timer = setTimeout(() => worker.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(fixture, { recursive: true, force: true });
}
