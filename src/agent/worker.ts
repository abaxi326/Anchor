import { createInterface } from 'node:readline';
import type { WorkerCommand, WorkerEvent } from '../shared';

// Only inference is networked. Do not fetch catalogs or install search executables.
process.env.PI_OFFLINE = '1';
delete process.env.RIPGREP_CONFIG_PATH;
const { AgentRuntime } = await import('./runtime');
const send = (event: WorkerEvent) => process.stdout.write(`${JSON.stringify(event)}\n`);
const runtime = new AgentRuntime(send);
let initializing: Promise<void> | undefined;
let initialized = false;
let closing = false;
let secret = '';

function report(error: unknown): void {
  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.split(secret).join('[redacted]');
  send({ type: 'error', message });
}

async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await initializing?.catch(() => {});
  await runtime.dispose();
  process.exit(0);
}

async function handle(command: WorkerCommand): Promise<void> {
  if (closing) return;
  if (command.type === 'init') {
    if (initializing || initialized) throw new Error('Agent is already initialized.');
    secret = command.config.model.apiKey;
    initializing = runtime.init(command.config);
    await initializing;
    initialized = true;
    return;
  }
  if (command.type === 'shutdown') return shutdown();
  if (command.type === 'approval') { runtime.approve(command.id, command.approved === true); return; }
  if (command.type === 'abort') { await runtime.abort(); return; }
  if (!initialized) throw new Error('Wait for the agent to connect.');
  if (command.type === 'mode') runtime.setMode(command.mode);
  else if (command.type === 'prompt') await runtime.prompt(command.text);
  else throw new Error('Unknown worker command.');
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  try {
    if (line.length > 1024 * 1024) throw new Error('Worker command is too large.');
    // Do not serialize this await: approvals and cancellation arrive during prompt().
    void handle(JSON.parse(line) as WorkerCommand).catch(report);
  } catch (error) { report(error); }
});
lines.on('close', () => { void shutdown().catch(() => process.exit(1)); });
process.on('SIGTERM', () => { void shutdown().catch(() => process.exit(1)); });
process.on('SIGINT', () => { void shutdown().catch(() => process.exit(1)); });
