import { access, lstat, mkdir, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { streamSimple as streamOpenAICompletions } from '@earendil-works/pi-ai/api/openai-completions';
import {
  createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  createBashToolDefinition, createPowerShellToolDefinition,
  type AgentSession, type AgentSessionEvent, type ResourceLoader, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { AgentMode, ChatEntry, WorkerConfig, WorkerEvent } from '../shared';
import { ApprovalBroker } from './approvals';
import { WorkspaceBoundary } from './workspace';
import { inferenceEndpoint, inferenceFetch } from './inference';

const READ_TOOLS = ['read', 'grep', 'find', 'ls'];
const PROVIDER = 'open-anchor-vllm';

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((item) => item?.type === 'text').map((item) => String(item.text)).join('\n');
}

/** No discovery: repository text is context, never code to load into the host. */
async function trustedResources(boundary: WorkspaceBoundary): Promise<ResourceLoader> {
  const agentsFiles: Array<{ path: string; content: string }> = [];
  try {
    const file = await boundary.resolve('AGENTS.md');
    const info = await lstat(file);
    if (info.isFile() && info.size <= 128 * 1024) agentsFiles.push({ path: file, content: await readFile(file, 'utf8') });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [
      'You are Open Anchor, a coding agent in VS Code. Work only on the requested task. ' +
      'Read repository instructions as context. File tools are limited to the workspace. ' +
      'Edit, write and shell operations require user approval. Never repeat a denied action unchanged. ' +
      'When only read, grep, find and ls are available, you are in Plan mode: inspect and propose a plan; do not modify anything. ' +
      'An approved shell runs with the user permissions and is not sandboxed. Prefer file tools for reads and edits.',
    ],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export class AgentRuntime {
  private session?: AgentSession;
  private mode: AgentMode = 'plan';
  private running?: Promise<void>;
  private readonly approvals: ApprovalBroker;
  private secret = '';
  private stopped = false;
  private shellName = process.platform === 'win32' ? 'powershell' : 'bash';

  constructor(private readonly emit: (event: WorkerEvent) => void) {
    this.approvals = new ApprovalBroker((request) => this.emit({ type: 'approval', request }));
  }

  private message(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return this.secret ? text.split(this.secret).join('[redacted]') : text;
  }

  async init(config: WorkerConfig): Promise<void> {
    if (this.session) throw new Error('Agent is already initialized.');
    this.mode = config.mode;
    this.secret = config.model.apiKey;
    const endpoint = inferenceEndpoint(config.model.baseUrl);
    const fetch = inferenceFetch(endpoint, Boolean(this.secret));
    if (!config.model.id || !Number.isSafeInteger(config.model.contextWindow) || !Number.isSafeInteger(config.model.maxTokens) ||
        config.model.contextWindow < 4096 || config.model.maxTokens < 256 ||
        config.model.maxTokens >= config.model.contextWindow) throw new Error('Invalid model or token limits.');
    const boundary = await WorkspaceBoundary.create(config.cwd);
    await mkdir(config.sessionDir, { recursive: true });
    const sessionDir = await realpath(config.sessionDir);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false,
    });
    modelRuntime.registerProvider(PROVIDER, {
      name: 'Open Anchor vLLM', baseUrl: endpoint.href.replace(/\/$/, ''), api: 'openai-completions',
      streamSimple: (model, context, options) => streamOpenAICompletions(
        { ...model, api: 'openai-completions' }, context, { ...options, fetch },
      ),
      models: [{
        // Qwen's capability stays enabled; thinkingLevel controls the user's switch.
        // Setting capability=false would omit enable_thinking:false and use vLLM's default.
        id: config.model.id, name: config.model.id, reasoning: true, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.model.contextWindow, maxTokens: config.model.maxTokens,
        compat: {
          supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
          supportsStrictMode: false, maxTokensField: 'max_tokens',
          thinkingFormat: 'qwen-chat-template', requiresReasoningContentOnAssistantMessages: true,
        },
      }],
    });
    await modelRuntime.setRuntimeApiKey(PROVIDER, this.secret || 'unused-local-token');
    const model = modelRuntime.getModel(PROVIDER, config.model.id);
    if (!model) throw new Error('Could not register the inference model.');
    let manager: SessionManager;
    if (config.sessionFile) {
      const sessionFile = await realpath(config.sessionFile);
      if (path.dirname(sessionFile) !== sessionDir) throw new Error('Session file is outside the session directory.');
      manager = SessionManager.open(sessionFile, sessionDir);
      if (await realpath(manager.getCwd()) !== boundary.root) throw new Error('Session belongs to another workspace.');
    } else manager = SessionManager.create(boundary.root, sessionDir);
    const definitions = this.createTools(boundary);
    const { session } = await createAgentSession({
      cwd: boundary.root, agentDir: path.join(sessionDir, 'runtime'),
      model, modelRuntime, thinkingLevel: config.model.reasoning ? 'medium' : 'off',
      sessionManager: manager, resourceLoader: await trustedResources(boundary),
      settingsManager: SettingsManager.inMemory({
        enableAnalytics: false, enableInstallTelemetry: false, cacheWarming: 'off',
        compaction: { enabled: true, reserveTokens: config.model.maxTokens, keepRecentTokens: Math.min(8192, Math.floor(config.model.contextWindow / 4)) },
        retry: { enabled: true, maxRetries: 1, provider: { maxRetries: 1, timeoutMs: 120000 } },
        images: { blockImages: true }, packages: [], extensions: [],
      }),
      tools: definitions.map((tool) => tool.name), customTools: definitions,
    });
    this.session = session;
    this.setMode(this.mode);
    session.subscribe((event) => this.onSessionEvent(event));
    const history: ChatEntry[] = [];
    for (const entry of manager.getBranch()) {
      if (entry.type !== 'message') continue;
      const message = entry.message;
      if (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult') {
        const text = contentText(message.content);
        if (text) history.push({
          id: entry.id, role: message.role === 'toolResult' ? 'tool' : message.role, text,
          ...(message.role === 'toolResult' ? { toolName: message.toolName, status: message.isError ? 'error' as const : 'done' as const } : {}),
        });
      }
    }
    this.emit({ type: 'ready', sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), history });
  }

  private createTools(boundary: WorkspaceBoundary): ToolDefinition<any, any>[] {
    const guardedRead = async (file: string) => readFile(await boundary.resolve(file));
    const guardedWrite = async (file: string, content: string) => {
      const target = await boundary.resolve(file, true);
      await writeFile(target, content, 'utf8');
    };
    const definitions: ToolDefinition<any, any>[] = [
      createReadToolDefinition(boundary.root, { operations: { readFile: guardedRead, access: async (file) => access(await boundary.resolve(file)) } }),
      createEditToolDefinition(boundary.root, { operations: { readFile: guardedRead, writeFile: guardedWrite, access: async (file) => access(await boundary.resolve(file)) } }),
      createWriteToolDefinition(boundary.root, { operations: {
        writeFile: guardedWrite,
        mkdir: async (dir) => { await mkdir(await boundary.resolve(dir, true), { recursive: true }); },
      } }),
      createLsToolDefinition(boundary.root, { operations: {
        exists: async (file) => { try { await boundary.resolve(file); return true; } catch { return false; } },
        stat: async (file) => lstat(await boundary.resolve(file)),
        readdir: async (file) => readdir(await boundary.resolve(file)),
      } }),
      createGrepToolDefinition(boundary.root, { operations: {
        isDirectory: async (file) => (await lstat(await boundary.resolve(file))).isDirectory(),
        readFile: async (file) => (await guardedRead(file)).toString('utf8'),
      } }),
      createFindToolDefinition(boundary.root),
      process.platform === 'win32'
        ? createPowerShellToolDefinition(boundary.root, { exposeSessionEnvironment: false })
        : createBashToolDefinition(boundary.root, { exposeSessionEnvironment: false }),
    ];
    return definitions.map((tool) => ({
      ...tool,
      // A single pending mutation makes the editor approval and snapshot unambiguous.
      executionMode: 'sequential',
      execute: async (id, params, signal, onUpdate, ctx) => {
        if (this.stopped || signal?.aborted) throw new Error('Operation cancelled.');
        const mutation = !READ_TOOLS.includes(tool.name);
        if (mutation && this.mode !== 'agent') throw new Error('Plan mode permits read-only tools only.');
        const input = { ...(params as Record<string, unknown>) };
        if (tool.name !== this.shellName) {
          if (input.path !== undefined && typeof input.path !== 'string') throw new Error('Invalid file path.');
          input.path = await boundary.resolve(String(input.path ?? '.'), tool.name === 'write');
        }
        if (mutation) {
          if (!(await this.approvals.request({ id, toolName: tool.name, input }, signal))) throw new Error('User denied or cancelled this operation.');
          if (this.mode !== 'agent' || this.stopped || signal?.aborted) throw new Error('Operation cancelled.');
          // Recheck after the user has had time to review the request.
          if (tool.name !== this.shellName) await boundary.resolve(String(input.path), tool.name === 'write');
        }
        return tool.execute(id, input, signal, onUpdate, ctx);
      },
    }));
  }

  private onSessionEvent(event: AgentSessionEvent): void {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      this.emit({ type: 'text', text: event.assistantMessageEvent.delta });
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      if (event.message.stopReason === 'error') this.emit({ type: 'error', message: this.message(event.message.errorMessage ?? 'Model request failed.') });
      this.emit({ type: 'assistantEnd' });
    } else if (event.type === 'tool_execution_start') {
      this.emit({ type: 'toolStart', id: event.toolCallId, toolName: event.toolName, input: event.args });
    } else if (event.type === 'tool_execution_end') {
      this.emit({ type: 'toolEnd', id: event.toolCallId, toolName: event.toolName, text: contentText(event.result.content), isError: event.isError });
    } else if (event.type === 'compaction_start') this.emit({ type: 'status', text: 'Compacting conversation context…' });
    else if (event.type === 'auto_retry_start') this.emit({ type: 'status', text: `Retrying inference (${event.attempt}/${event.maxAttempts})…` });
  }

  setMode(mode: AgentMode): void {
    if (mode !== 'plan' && mode !== 'agent') throw new Error('Unknown agent mode.');
    if (this.running) throw new Error('Stop the active task before changing mode.');
    this.mode = mode;
    this.session?.setActiveToolsByName(mode === 'plan' ? READ_TOOLS : [...READ_TOOLS, 'edit', 'write', this.shellName]);
  }

  prompt(text: string): Promise<void> {
    if (!this.session || this.stopped) return Promise.reject(new Error('Agent is not connected.'));
    if (this.running) return Promise.reject(new Error('A task is already running.'));
    if (!text.trim() || text.length > 128000) return Promise.reject(new Error('Enter a prompt of at most 128,000 characters.'));
    this.running = this.session.prompt(text).catch((error) => {
      this.emit({ type: 'error', message: this.message(error) });
    }).finally(() => {
      this.approvals.cancelAll();
      this.running = undefined;
      this.emit({ type: 'idle' });
    });
    return this.running;
  }

  approve(id: string, approved: boolean): void { this.approvals.answer(id, approved); }
  async abort(): Promise<void> { this.approvals.cancelAll(); await this.session?.abort(); }
  async dispose(): Promise<void> {
    this.stopped = true;
    await this.abort();
    await this.running;
    this.session?.dispose();
    this.secret = '';
  }
}
