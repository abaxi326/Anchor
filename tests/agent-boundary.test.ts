import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceBoundary } from '../src/agent/workspace';
import { ApprovalBroker } from '../src/agent/approvals';

test('file boundary rejects traversal and symlink/junction escapes including new writes', async () => {
  await mkdir('.test-artifacts', { recursive: true });
  const base = await mkdtemp(path.resolve('.test-artifacts', 'agent-boundary-'));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'private');
  try {
    const boundary = await WorkspaceBoundary.create(root);
    await assert.rejects(boundary.resolve('../outside/secret.txt'), /outside/);
    await assert.rejects(boundary.resolve(path.join(outside, 'secret.txt')), /outside/);
    await assert.rejects(boundary.resolve('../new.txt', true), /outside/);
    await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(boundary.resolve('link/secret.txt'), /symbolic links/);
    await assert.rejects(boundary.resolve('link/new.txt', true), /symbolic links/);
    assert.equal(await boundary.resolve('sub/new.txt', true), path.join(root, 'sub', 'new.txt'));
    await assert.rejects(boundary.resolve('https://example.com'), /regular file path/);
    if (process.platform === 'win32') await assert.rejects(boundary.resolve('file.txt:stream', true), /alternate data streams/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('approval broker fails closed on abort and ignores late answers', async () => {
  const emitted: string[] = [];
  const broker = new ApprovalBroker((request) => emitted.push(request.id));
  const abort = new AbortController();
  const result = broker.request({ id: 'tool-1', toolName: 'write', input: {} }, abort.signal);
  abort.abort();
  broker.answer('tool-1', true);
  assert.equal(await result, false);
  assert.deepEqual(emitted, ['tool-1']);
  const second = broker.request({ id: 'tool-2', toolName: 'bash', input: {} });
  broker.cancelAll();
  assert.equal(await second, false);
});
