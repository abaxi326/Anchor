import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { WorkerCommand, WorkerConfig, WorkerEvent } from '../shared';

export class AgentClient {
  private process?: ChildProcessWithoutNullStreams;
  private stopping = false;
  constructor(private readonly onEvent: (event: WorkerEvent) => void, private readonly log: (text: string) => void) {}

  async start(nodePath: string, workerPath: string, config: WorkerConfig): Promise<void> {
    if (this.process) throw new Error('An agent process is already running.');
    this.stopping = false;
    const child = spawn(nodePath, [workerPath], {
      cwd: config.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    this.process = child;
    const lines = createInterface({ input: child.stdout });
    const redact = (s: string) => config.model.apiKey ? s.split(config.model.apiKey).join('[redacted]') : s;
    const diagnostics = createInterface({ input: child.stderr });
    // Assemble a whole diagnostic line before redaction: stream chunks can split credentials.
    diagnostics.on('line', (line) => this.log(redact(line).slice(0, 8000)));
    child.stdin.on('error', () => { /* exit/error reports the failed process */ });
    await new Promise<void>((resolve, reject) => {
      let initialized = false;
      const timer = setTimeout(() => {
        reject(new Error('Pi did not become ready within 60 seconds. Check the Node.js path and logs.'));
        void this.stop();
      }, 60_000);
      lines.on('line', (line) => {
        try {
          if (line.length > 16_000_000) throw new Error('Agent message exceeded the size limit.');
          const event = JSON.parse(line) as WorkerEvent;
          if (!event || typeof event.type !== 'string') throw new Error('Invalid agent message.');
          if (event.type === 'ready') { initialized = true; clearTimeout(timer); resolve(); }
          if (event.type === 'error' && !initialized) { clearTimeout(timer); reject(new Error(event.message)); }
          this.onEvent(event);
        } catch (error) {
          this.log(`Agent protocol: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        this.process = undefined;
        reject(new Error(`Cannot start Pi. Install Node.js 22.19+ or configure openAnchor.nodePath. ${error.message}`));
      });
      child.once('exit', (code) => {
        clearTimeout(timer); lines.close(); diagnostics.close();
        if (this.process === child) this.process = undefined;
        if (!initialized) reject(new Error(`Pi exited before initialization (code ${code}). Check logs.`));
        else if (!this.stopping) this.onEvent({ type: 'error', fatal: true, message: `Pi process exited (code ${code}). Reconnect to resume your session.` });
      });
      this.send({ type: 'init', config });
    });
  }

  send(command: WorkerCommand): void {
    if (!this.process || this.process.killed || !this.process.stdin.writable) throw new Error('The agent is not connected.');
    this.process.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.stopping = true;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
      const deadline = setTimeout(() => reject(new Error('The agent process did not exit after termination.')), 10_000);
      child.once('close', () => { clearTimeout(timer); clearTimeout(deadline); resolve(); });
      try { this.send({ type: 'shutdown' }); } catch { child.kill('SIGKILL'); }
    });
    if (this.process === child) this.process = undefined;
  }
}
