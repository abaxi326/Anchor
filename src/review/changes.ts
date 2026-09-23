import { readFile, writeFile, unlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

interface Snapshot { before: Buffer | null; after?: Buffer | null; }
const LIMIT = 2 * 1024 * 1024;

export async function resolveWorkspacePath(root: string, input: string): Promise<string> {
  const resolvedRoot = await realpath(root);
  const absolute = path.resolve(root, input);
  let ancestor = absolute;
  const missing: string[] = [];
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error('Cannot resolve file path.');
      missing.unshift(path.basename(ancestor)); ancestor = parent;
    }
  }
  const canonical = path.join(ancestor, ...missing);
  const relative = path.relative(resolvedRoot, canonical);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('File edits must stay inside the selected workspace.');
  }
  if (relative.split(path.sep).some((segment) => segment.toLowerCase() === '.git')) throw new Error('Direct edits inside .git are not allowed.');
  return canonical;
}

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('The edit target must be a regular file.');
    if (info.nlink > 1) throw new Error('Change review does not support files with multiple hard links.');
    if (info.size > LIMIT) throw new Error('Change review supports files up to 2 MB.');
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
const equal = (a: Buffer | null, b: Buffer | null) => a === null || b === null ? a === b : a.equals(b);

/** Tracks only edits made through Pi file tools; terminal changes remain visible in Git. */
export class ChangeTracker {
  private readonly files = new Map<string, Snapshot>();
  constructor(readonly root: string) {}
  async stage(input: string): Promise<string> {
    const file = await resolveWorkspacePath(this.root, input);
    const current = await readOptional(file);
    const previous = this.files.get(file);
    // A user edit between agent operations becomes the new baseline, never undo it.
    if (!previous || previous.after === undefined || !equal(current, previous.after)) this.files.set(file, { before: current });
    return file;
  }
  async captureAfter(input: string): Promise<void> {
    const file = await resolveWorkspacePath(this.root, input);
    const snapshot = this.files.get(file);
    if (snapshot) snapshot.after = await readOptional(file);
  }
  paths(): string[] {
    return [...this.files.entries()].filter(([, s]) => s.after !== undefined && !equal(s.before, s.after)).map(([file]) => path.relative(this.root, file));
  }
  async beforeText(input: string): Promise<string> {
    const file = await resolveWorkspacePath(this.root, input);
    const snapshot = this.files.get(file);
    if (!snapshot) throw new Error('No change snapshot is available for this file.');
    return snapshot.before?.toString('utf8') ?? '';
  }
  async undo(input: string): Promise<void> {
    const file = await resolveWorkspacePath(this.root, input);
    const snapshot = this.files.get(file);
    if (!snapshot || snapshot.after === undefined) throw new Error('No completed agent edit is available to undo.');
    const current = await readOptional(file);
    if (!equal(current, snapshot.after)) throw new Error('This file changed after the agent edit. Review and revert it manually to preserve your changes.');
    if (snapshot.before === null) { if (current !== null) await unlink(file); }
    else await writeFile(file, snapshot.before);
    this.files.delete(file);
  }
  clear(): void { this.files.clear(); }
}
