import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChangeTracker, resolveWorkspacePath } from '../src/review/changes';

test('undo restores preexisting user content and removes agent-created files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anchor-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'existing.ts'), 'user work');
  const tracker = new ChangeTracker(root);
  await tracker.stage('existing.ts');
  await writeFile(path.join(root, 'existing.ts'), 'agent work');
  await tracker.captureAfter('existing.ts');
  assert.deepEqual(tracker.paths(), ['existing.ts']);
  await tracker.undo('existing.ts');
  assert.equal(await readFile(path.join(root, 'existing.ts'), 'utf8'), 'user work');
  await tracker.stage('new.ts');
  await writeFile(path.join(root, 'new.ts'), 'new');
  await tracker.captureAfter('new.ts');
  await tracker.undo('new.ts');
  await assert.rejects(readFile(path.join(root, 'new.ts')), { code: 'ENOENT' });
});

test('undo refuses to overwrite edits made after the agent', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anchor-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'file.ts');
  await writeFile(file, 'original');
  const tracker = new ChangeTracker(root);
  await tracker.stage('file.ts'); await writeFile(file, 'agent'); await tracker.captureAfter('file.ts');
  await writeFile(file, 'user changed this');
  await assert.rejects(tracker.undo('file.ts'), /changed after/);
  assert.equal(await readFile(file, 'utf8'), 'user changed this');
});

test('review rejects traversal, git internals, and junction escapes', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'anchor-paths-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'workspace'); const other = path.join(parent, 'outside');
  await mkdir(root); await mkdir(other);
  await assert.rejects(resolveWorkspacePath(root, '../outside/secret'), /inside/);
  await assert.rejects(resolveWorkspacePath(root, '.git/config'), /\.git/);
  await symlink(other, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveWorkspacePath(root, 'linked/new.txt'), /inside/);
});

test('a manual edit between two agent edits becomes the undo baseline', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'anchor-between-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'file.ts');
  await writeFile(file, 'original');
  const tracker = new ChangeTracker(root);
  await tracker.stage('file.ts'); await writeFile(file, 'first agent edit'); await tracker.captureAfter('file.ts');
  await writeFile(file, 'user addition');
  await tracker.stage('file.ts'); await writeFile(file, 'second agent edit'); await tracker.captureAfter('file.ts');
  await tracker.undo('file.ts');
  assert.equal(await readFile(file, 'utf8'), 'user addition');
});
