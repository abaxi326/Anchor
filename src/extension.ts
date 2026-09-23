import * as vscode from 'vscode';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { SshConnection } from './connection/ssh';
import { HttpConnection } from './connection/http';
import { validateProfile } from './connection/validation';
import { AgentClient } from './runtime/client';
import { ChangeTracker, resolveWorkspacePath } from './review/changes';
import { DEFAULT_PROFILE, type ConnectionProfile, type ViewState, type WebviewMessage, type WorkerEvent } from './shared';

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

class AnchorSidebar implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private agent?: AgentClient;
  private connection?: SshConnection | HttpConnection;
  private connecting?: AbortController;
  private generation = 0;
  private workspace?: vscode.WorkspaceFolder;
  private tracker?: ChangeTracker;
  private readonly edits = new Map<string, string>();
  private assistantId?: string;
  private publishTimer?: ReturnType<typeof setTimeout>;
  private readonly baselineEmitter = new vscode.EventEmitter<vscode.Uri>();
  private state: ViewState;
  private stopping?: Promise<void>;
  private disposed = false;
  private configuring = false;
  private restarting = false;
  private events: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    this.workspace = vscode.workspace.workspaceFolders?.[0];
    const saved = context.globalState.get<Partial<ConnectionProfile>>('profile');
    this.state = {
      profile: { ...DEFAULT_PROFILE, ...saved, transport: saved?.transport ?? (saved?.host ? 'ssh' : 'http') },
      connection: 'disconnected', connectionMessage: 'Connect to your running GPU to begin.',
      agentStatus: 'idle', mode: 'plan', entries: [], changes: [],
      workspaceName: this.workspace?.name ?? '', canResume: false,
      hasApiKey: false, hasPassphrase: false,
    };
    this.updateResume();
    context.subscriptions.push(this.baselineEmitter, vscode.workspace.registerTextDocumentContentProvider('open-anchor-before', {
      onDidChange: this.baselineEmitter.event,
      provideTextDocumentContent: async (uri) => this.tracker?.beforeText(uri.query) ?? '',
    }));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    const nonce = randomBytes(18).toString('base64');
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'));
    view.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${view.webview.cspSource};"><link rel="stylesheet" href="${style}"><title>Open Anchor</title></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handle(message).catch((error: unknown) => this.reportError(error));
    }, undefined, this.context.subscriptions);
    view.onDidDispose(() => { if (this.view === view) this.view = undefined; }, undefined, this.context.subscriptions);
    void this.refreshSecretFlags();
  }

  private sessionKey(): string { return `lastSession.${hash(this.workspace?.uri.fsPath ?? '')}`; }
  private sessionDir(): string { return path.join(this.context.globalStorageUri.fsPath, 'sessions', hash(this.workspace!.uri.fsPath)); }
  private updateResume(): void { this.state.canResume = Boolean(this.workspace && this.context.globalState.get(this.sessionKey())); }
  private secretPrefix(profile = this.state.profile): string {
    const address = profile.transport === 'http' ? `http:${profile.baseUrl}`
      : `${profile.host}:${profile.port}:${profile.username}:${profile.privateKeyPath}`;
    return `connection.${hash(address)}`;
  }

  private async refreshSecretFlags(): Promise<void> {
    const key = this.secretPrefix();
    this.state.hasApiKey = Boolean(await this.context.secrets.get(`${key}.apiKey`));
    this.state.hasPassphrase = Boolean(await this.context.secrets.get(`${key}.passphrase`));
    this.publish();
  }

  private publish(): void {
    if (this.publishTimer || this.disposed) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      void this.view?.webview.postMessage({ type: 'state', state: this.state });
    }, 30);
  }

  private reportError(error: unknown): void {
    const message = errorText(error);
    this.output.appendLine(message);
    this.state.entries.push({ id: randomUUID(), role: 'system', text: message, status: 'error' });
    this.publish();
    void vscode.window.showErrorMessage(`Open Anchor: ${message}`);
  }

  private async saveProfile(message: { profile: ConnectionProfile; apiKey?: string; passphrase?: string }): Promise<void> {
    if (this.state.connection === 'connecting' || this.state.connection === 'ready') throw new Error('Disconnect before changing the connection profile.');
    const profile = validateProfile(message.profile);
    const prefix = this.secretPrefix(profile);
    for (const name of ['apiKey', 'passphrase'] as const) {
      const value = message[name];
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid connection secret.');
      if (value) await this.context.secrets.store(`${prefix}.${name}`, value);
      else await this.context.secrets.delete(`${prefix}.${name}`);
    }
    await this.context.globalState.update('profile', profile);
    this.state.profile = profile;
    await this.refreshSecretFlags();
  }

  private async handle(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') return;
    const message = raw as WebviewMessage;
    switch (message.type) {
      case 'ready': await this.refreshSecretFlags(); return;
      case 'saveProfile': await this.saveProfile(message); return;
      case 'connect':
        if (this.configuring) return;
        this.configuring = true;
        try { await this.saveProfile(message); await this.connect(); } finally { this.configuring = false; }
        return;
      case 'disconnect': await this.disconnect(); return;
      case 'selectKey': {
        if (this.state.connection === 'connecting' || this.state.connection === 'ready') return;
        const selected = await vscode.window.showOpenDialog({ title: 'Select SSH private key', canSelectMany: false, canSelectFolders: false });
        if (selected?.[0]) { this.state.profile = { ...this.state.profile, privateKeyPath: selected[0].fsPath }; this.publish(); }
        return;
      }
      case 'prompt': {
        if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 100_000) throw new Error('Enter a task of at most 100,000 characters.');
        this.requireReady();
        if (this.restarting) throw new Error('Wait for the session switch to finish.');
        if (this.state.agentStatus !== 'idle') throw new Error('Wait for the current task or stop it first.');
        this.assistantId = undefined;
        this.state.entries.push({ id: randomUUID(), role: 'user', text: message.text.trim() });
        this.state.agentStatus = 'running';
        try { this.agent!.send({ type: 'prompt', text: message.text.trim() }); }
        catch (error) { this.state.agentStatus = 'idle'; throw error; }
        this.publish(); return;
      }
      case 'abort':
        this.rejectApproval(); this.agent?.send({ type: 'abort' }); this.publish(); return;
      case 'mode':
        if (message.mode !== 'plan' && message.mode !== 'agent') return;
        if (this.state.agentStatus !== 'idle') throw new Error('Stop the current task before switching modes.');
        this.state.mode = message.mode; this.agent?.send({ type: 'mode', mode: message.mode }); this.publish(); return;
      case 'approve':
        if (typeof message.id !== 'string' || typeof message.approved !== 'boolean') return;
        await this.approve(message.id, message.approved); return;
      case 'newSession': await this.restartAgent(false); return;
      case 'resumeSession': await this.restartAgent(true); return;
      case 'reviewFile':
        if (typeof message.path !== 'string') return;
        await this.reviewFile(message.path); return;
      case 'undoFile':
        if (typeof message.path !== 'string') return;
        await this.undoFile(message.path); return;
      case 'showLogs': this.output.show(true); return;
    }
  }

  private requireReady(): void {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before starting the coding agent.');
    if (this.state.connection !== 'ready' || !this.agent) throw new Error('Connect to the GPU first.');
  }

  private async chooseWorkspace(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) throw new Error('Open a local, WSL, or remote folder before connecting.');
    if (folders.length > 1) {
      const selected = await vscode.window.showQuickPick(folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })), { title: 'Select the agent workspace', ignoreFocusOut: true });
      if (!selected) throw new Error('Workspace selection cancelled.');
      this.workspace = selected.folder;
    } else this.workspace = folders[0];
    this.state.workspaceName = this.workspace.name;
    this.updateResume();
  }

  private async connect(): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before connecting.');
    if (this.stopping) await this.stopping;
    if (this.connecting || this.state.connection === 'ready') return;
    await this.chooseWorkspace();
    const generation = ++this.generation;
    const controller = new AbortController(); this.connecting = controller;
    this.state.connection = 'connecting';
    this.state.connectionMessage = this.state.profile.transport === 'http'
      ? 'Checking the inference worker…' : 'Opening SSH tunnel and checking the model…';
    this.publish();
    const connection = this.state.profile.transport === 'http'
      ? new HttpConnection({ log: (text) => this.output.appendLine(text) })
      : new SshConnection({
      log: (text) => this.output.appendLine(text),
      onHostKey: async (host, port, fingerprint) => {
        const key = `hostKey.${hash(`${host}:${port}`)}`;
        const known = this.context.globalState.get<string>(key);
        if (known) {
          if (known !== fingerprint) throw new Error('SSH host key changed. Verify the server, then use “Open Anchor: Reset Trusted SSH Host” if it was replaced.');
          return true;
        }
        const answer = await vscode.window.showWarningMessage(`Trust SSH host ${host}:${port}?\nFingerprint: ${fingerprint}\nVerify this against your server before trusting it.`, { modal: true }, 'Trust Host');
        if (answer !== 'Trust Host' || controller.signal.aborted) return false;
        await this.context.globalState.update(key, fingerprint); return true;
      },
      onClose: (error) => {
        if (generation !== this.generation) return;
        const shutdown = this.disconnect();
        const closedGeneration = this.generation;
        void shutdown.then(() => {
          if (this.generation !== closedGeneration) return;
          this.state.connection = 'error';
          this.state.connectionMessage = error?.message ?? 'SSH connection lost. Reconnect to resume.';
          this.publish();
        }).catch((failure) => this.reportError(failure));
      },
    });
    this.connection = connection;
    try {
      const prefix = this.secretPrefix();
      const apiKey = await this.context.secrets.get(`${prefix}.apiKey`) ?? '';
      const passphrase = await this.context.secrets.get(`${prefix}.passphrase`);
      const endpoint = await connection.connect(this.state.profile, { apiKey, passphrase }, controller.signal);
      if (controller.signal.aborted || generation !== this.generation) return;
      this.endpoint = { ...endpoint, apiKey };
      this.state.connectionMessage = `Connected · ${endpoint.model}`;
      this.tracker ??= new ChangeTracker(this.workspace!.uri.fsPath);
      if (this.tracker.root !== this.workspace!.uri.fsPath) this.tracker = new ChangeTracker(this.workspace!.uri.fsPath);
      this.state.changes = this.tracker.paths();
      await this.startAgent(true, generation);
      if (controller.signal.aborted || generation !== this.generation) return;
      this.state.connection = 'ready'; this.publish();
    } catch (error) {
      if (generation === this.generation) {
        await this.disconnect(); this.state.connection = 'error'; this.state.connectionMessage = errorText(error); this.publish(); throw error;
      }
    } finally { if (this.connecting === controller) this.connecting = undefined; }
  }

  private endpoint?: { baseUrl: string; model: string; apiKey: string };

  private async startAgent(resume: boolean, generation = this.generation): Promise<void> {
    if (!this.endpoint || !this.workspace) throw new Error('The model connection is unavailable.');
    const endpoint = this.endpoint;
    const workspace = this.workspace;
    const sessionDir = this.sessionDir(); await mkdir(sessionDir, { recursive: true });
    let sessionFile = resume ? this.context.globalState.get<string>(this.sessionKey()) : undefined;
    if (sessionFile) {
      try { await access(sessionFile); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') sessionFile = undefined; else throw error; }
    }
    if (generation !== this.generation || !this.endpoint || this.disposed) throw new Error('Connection cancelled.');
    const agent = new AgentClient((event) => {
      this.events = this.events.then(async () => {
        if (generation === this.generation && this.agent === agent) await this.onAgentEvent(event);
      }).catch((error) => this.reportError(error));
    }, (text) => this.output.appendLine(text));
    this.agent = agent;
    await agent.start(vscode.workspace.getConfiguration('openAnchor').get<string>('nodePath', 'node'),
      path.join(this.context.extensionPath, 'dist', 'worker.mjs'), {
        cwd: workspace.uri.fsPath, sessionDir, sessionFile, mode: this.state.mode,
        model: { id: endpoint.model, baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey,
          contextWindow: this.state.profile.contextWindow, maxTokens: this.state.profile.maxTokens, reasoning: this.state.profile.reasoning },
      });
  }

  private async restartAgent(resume: boolean): Promise<void> {
    this.requireReady();
    if (this.restarting) return;
    if (this.state.agentStatus !== 'idle') throw new Error('Stop the current task before switching sessions.');
    this.restarting = true;
    const generation = this.generation;
    try {
    if (!resume && this.state.changes.length) {
      const answer = await vscode.window.showWarningMessage('Start a new session? Current file edits stay on disk; their in-memory undo snapshots will be cleared.', { modal: true }, 'New Session');
      if (answer !== 'New Session') return;
    }
    if (generation !== this.generation) return;
    this.state.connection = 'connecting'; this.state.connectionMessage = 'Opening agent session…'; this.publish();
    try {
      await this.agent?.stop(); this.agent = undefined;
      if (generation !== this.generation) return;
      if (!resume) { await this.context.globalState.update(this.sessionKey(), undefined); this.tracker?.clear(); this.state.changes = []; }
      await this.startAgent(resume, generation);
      if (generation !== this.generation) return;
      this.state.connection = 'ready'; this.state.connectionMessage = `Connected · ${this.endpoint!.model}`;
    } catch (error) { if (generation === this.generation) { await this.disconnect(); throw error; } }
    this.publish();
    } finally { this.restarting = false; }
  }

  private async onAgentEvent(event: WorkerEvent): Promise<void> {
    switch (event.type) {
      case 'ready':
        this.state.sessionId = event.sessionId; this.state.entries = event.history; this.state.agentStatus = 'idle'; this.assistantId = undefined;
        if (event.sessionFile) await this.context.globalState.update(this.sessionKey(), event.sessionFile);
        this.updateResume(); break;
      case 'text': {
        let entry = this.state.entries.find((item) => item.id === this.assistantId);
        if (!entry) { this.assistantId = randomUUID(); entry = { id: this.assistantId, role: 'assistant', text: '' }; this.state.entries.push(entry); }
        entry.text += event.text; break;
      }
      case 'assistantEnd': this.assistantId = undefined; break;
      case 'toolStart':
        this.assistantId = undefined;
        this.state.entries.push({ id: event.id, role: 'tool', toolName: event.toolName, text: JSON.stringify(event.input, null, 2), status: 'running' }); break;
      case 'toolEnd': {
        const entry = this.state.entries.find((item) => item.id === event.id);
        if (entry) { entry.status = event.isError ? 'error' : 'done'; entry.text += `\n\n${event.text}`; }
        const file = this.edits.get(event.id);
        if (file) { await this.tracker?.captureAfter(file); this.edits.delete(event.id); this.state.changes = this.tracker?.paths() ?? []; }
        break;
      }
      case 'approval':
        if (this.state.approval) { this.agent?.send({ type: 'approval', id: event.request.id, approved: false }); break; }
        this.state.approval = event.request; this.state.agentStatus = 'waitingApproval'; break;
      case 'status': this.state.entries.push({ id: randomUUID(), role: 'system', text: event.text }); break;
      case 'idle':
        this.state.agentStatus = 'idle'; this.state.approval = undefined; this.assistantId = undefined; break;
      case 'error':
        this.rejectApproval(); this.assistantId = undefined;
        if (event.fatal) { await this.disconnect(); this.state.connection = 'error'; this.state.connectionMessage = event.message; }
        this.state.entries.push({ id: randomUUID(), role: 'system', text: event.message, status: 'error' });
        this.output.appendLine(event.message); break;
    }
    this.publish();
  }

  private async approve(id: string, approved: boolean): Promise<void> {
    const request = this.state.approval;
    if (!request || request.id !== id) return;
    if (approved && (request.toolName === 'edit' || request.toolName === 'write')) {
      try {
        const input = request.input.path;
        if (typeof input !== 'string' || !this.tracker) throw new Error('Cannot review this edit target.');
        const file = await resolveWorkspacePath(this.tracker.root, input);
        this.checkDirty(file);
        await this.tracker.stage(input); this.edits.set(id, file);
      } catch (error) { approved = false; this.reportError(error); }
    }
    if (this.state.approval?.id !== id || !this.agent) return;
    this.state.approval = undefined; this.state.agentStatus = 'running';
    this.agent.send({ type: 'approval', id, approved }); this.publish();
  }

  private rejectApproval(): void {
    const request = this.state.approval; this.state.approval = undefined;
    if (request && this.agent) { try { this.agent.send({ type: 'approval', id: request.id, approved: false }); } catch { /* agent has already stopped */ } }
  }

  private checkDirty(file: string): void {
    const document = vscode.workspace.textDocuments.find((doc) => path.resolve(doc.uri.fsPath).toLowerCase() === path.resolve(file).toLowerCase());
    if (document?.isDirty) throw new Error('Save or discard unsaved editor changes before approving or undoing an edit to this file.');
  }

  private async reviewFile(input: string): Promise<void> {
    if (!this.tracker || !this.state.changes.includes(input)) throw new Error('No reviewed agent edit is available.');
    const file = await resolveWorkspacePath(this.tracker.root, input);
    const before = vscode.Uri.from({ scheme: 'open-anchor-before', path: `/${path.basename(file)}`, query: input });
    this.baselineEmitter.fire(before);
    await vscode.commands.executeCommand('vscode.diff', before, vscode.Uri.file(file), `${input} — Agent changes`, { preview: true });
  }

  private async undoFile(input: string): Promise<void> {
    if (this.state.agentStatus !== 'idle') throw new Error('Stop the task before undoing an edit.');
    if (!this.tracker || !this.state.changes.includes(input)) throw new Error('No reviewed agent edit is available.');
    this.checkDirty(await resolveWorkspacePath(this.tracker.root, input));
    await this.tracker.undo(input); this.state.changes = this.tracker.paths(); this.publish();
  }

  async disconnect(): Promise<void> {
    if (this.stopping) return this.stopping;
    ++this.generation; this.connecting?.abort(); this.connecting = undefined; this.rejectApproval();
    const agent = this.agent; this.agent = undefined;
    const connection = this.connection; this.connection = undefined; this.endpoint = undefined;
    this.state.connection = 'disconnected'; this.state.connectionMessage = 'Disconnected. Your GPU remains running in Vast.ai.';
    this.state.agentStatus = 'idle'; this.assistantId = undefined; this.publish();
    this.stopping = (async () => {
      try { await agent?.stop(); } finally { await connection?.disconnect(); }
      for (const file of this.edits.values()) { try { await this.tracker?.captureAfter(file); } catch { /* interrupted edit may not have reached disk */ } }
      this.edits.clear(); this.state.changes = this.tracker?.paths() ?? []; this.publish();
    })();
    try { await this.stopping; } finally { this.stopping = undefined; }
  }

  async resetHostKey(): Promise<void> {
    if (this.state.connection !== 'disconnected' && this.state.connection !== 'error') throw new Error('Disconnect first.');
    if (this.state.profile.transport !== 'ssh') { void vscode.window.showInformationMessage('Direct API connections do not use SSH host keys.'); return; }
    const { host, port } = this.state.profile;
    const answer = await vscode.window.showWarningMessage(`Forget the trusted SSH key for ${host}:${port}? Verify the new fingerprint when connecting again.`, { modal: true }, 'Forget Host Key');
    if (answer === 'Forget Host Key') await this.context.globalState.update(`hostKey.${hash(`${host}:${port}`)}`, undefined);
  }

  async forgetSecrets(): Promise<void> {
    const prefix = this.secretPrefix();
    await this.context.secrets.delete(`${prefix}.apiKey`); await this.context.secrets.delete(`${prefix}.passphrase`);
    await this.refreshSecretFlags();
  }

  dispose(): void { this.disposed = true; if (this.publishTimer) clearTimeout(this.publishTimer); void this.disconnect(); }
}

let sidebar: AnchorSidebar | undefined;
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Open Anchor');
  sidebar = new AnchorSidebar(context, output);
  context.subscriptions.push(output, sidebar,
    vscode.window.registerWebviewViewProvider('openAnchor.sidebar', sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('openAnchor.open', () => vscode.commands.executeCommand('openAnchor.sidebar.focus')),
    vscode.commands.registerCommand('openAnchor.disconnect', () => sidebar?.disconnect()),
    vscode.commands.registerCommand('openAnchor.showLogs', () => output.show(true)),
    vscode.commands.registerCommand('openAnchor.resetHostKey', () => sidebar?.resetHostKey()),
    vscode.commands.registerCommand('openAnchor.forgetSecrets', () => sidebar?.forgetSecrets()),
  );
}
export async function deactivate(): Promise<void> { await sidebar?.disconnect(); }
