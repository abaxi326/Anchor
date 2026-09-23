import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

/** File-tool boundary only. Approved shell commands retain the user's OS access. */
export class WorkspaceBoundary {
  private constructor(readonly root: string) {}

  static async create(root: string): Promise<WorkspaceBoundary> {
    return new WorkspaceBoundary(await realpath(root));
  }

  async resolve(input: string, allowMissing = false): Promise<string> {
    if (!input || input.includes('\0') || input.startsWith('~') || /^[a-z][a-z\d+.-]*:\/\//i.test(input)) {
      throw new Error('Use a regular file path inside the workspace.');
    }
    const absolute = path.resolve(this.root, input);
    const relative = path.relative(this.root, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('File tools cannot access paths outside the workspace.');
    }
    // Reject NTFS alternate data streams and device/drive-relative path tricks.
    if (process.platform === 'win32' && (relative.includes(':') || input.startsWith('\\\\'))) {
      throw new Error('Device paths and alternate data streams are not supported.');
    }
    let current = this.root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error('File tools cannot follow symbolic links or junctions.');
        const canonical = await realpath(current);
        const rel = path.relative(this.root, canonical);
        if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
          throw new Error('Resolved path leaves the workspace.');
        }
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return absolute;
        throw error;
      }
    }
    return absolute;
  }
}
