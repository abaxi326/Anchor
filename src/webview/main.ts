import type { AgentMode, ChatEntry, ConnectionProfile, HostMessage, ViewState, WebviewMessage } from '../shared';
import { DEFAULT_PROFILE } from '../shared';
import './style.css';

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscode = acquireVsCodeApi();
const send = (message: WebviewMessage): void => vscode.postMessage(message);
const root = document.getElementById('root') ?? document.body.appendChild(document.createElement('div'));
root.id = 'root';
root.className = 'app';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(text: string, action: () => void, className = 'button secondary'): HTMLButtonElement {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function field(id: string, labelText: string, options: { type?: string; placeholder?: string; required?: boolean; hint?: string } = {}) {
  const wrapper = element('div', 'field');
  const label = element('label', '', labelText);
  label.htmlFor = id;
  const input = element('input');
  input.id = id;
  input.name = id;
  input.type = options.type ?? 'text';
  input.placeholder = options.placeholder ?? '';
  input.required = options.required ?? false;
  input.autocomplete = 'off';
  input.spellcheck = false;
  wrapper.append(label, input);
  if (options.hint) {
    const hint = element('p', 'hint', options.hint);
    hint.id = `${id}-hint`;
    input.setAttribute('aria-describedby', hint.id);
    wrapper.append(hint);
  }
  return { wrapper, input };
}

let state: ViewState | undefined;
let lastProfile: ConnectionProfile | undefined;
let submitted = false;
let submittedEntryCount = 0;
let approvalId: string | undefined;

const header = element('header', 'app-header');
const identity = element('div', 'identity');
identity.append(element('span', 'brand-mark', '⚓'), element('h1', '', 'Open Anchor'));
const logs = button('Logs', () => send({ type: 'showLogs' }), 'button quiet compact');
logs.title = 'Open connection and agent logs';
header.append(identity, logs);

const connectionPanel = element('details', 'connection-panel');
connectionPanel.open = true;
const connectionSummary = element('summary', 'connection-summary');
const statusDot = element('span', 'status-dot');
statusDot.setAttribute('aria-hidden', 'true');
const statusLabel = element('span', 'connection-label', 'Not connected');
const connectionHint = element('span', 'connection-hint', 'API settings');
connectionSummary.append(statusDot, statusLabel, connectionHint);
const connectionBody = element('div', 'connection-body');
const connectionMessage = element('p', 'connection-message');
connectionMessage.setAttribute('role', 'status');
connectionMessage.setAttribute('aria-live', 'polite');
const connectionForm = element('form', 'connection-form');
const apiAddress = field('api-address', 'API address', {
  placeholder: 'https://your-proxy or 203.0.113.10:8000', required: true,
  hint: 'Use the vLLM HTTP address from Vast.ai: a proxy URL or public IP:port, not the SSH port.',
});
const httpNote = element('p', 'hint', 'HTTP sends requests without encryption. Use HTTPS when available.');
httpNote.hidden = true;
apiAddress.wrapper.append(httpNote);
const apiKey = field('api-key', 'Model API key (optional)', { type: 'password', placeholder: 'Optional' });
const host = field('ssh-host', 'SSH host', { placeholder: '203.0.113.10', required: true });
const port = field('ssh-port', 'SSH port', { type: 'number', required: true });
port.input.min = '1';
port.input.max = '65535';
const username = field('ssh-user', 'SSH username', { placeholder: 'root', required: true });
const key = field('ssh-key', 'Private key file', { placeholder: 'C:\\Users\\you\\.ssh\\id_ed25519', required: true });
const keyRow = element('div', 'input-action');
const browse = button('Browse', () => send({ type: 'selectKey' }), 'button secondary compact');
browse.setAttribute('aria-label', 'Browse for SSH private key');
key.input.replaceWith(keyRow);
keyRow.append(key.input, browse);
const remotePort = field('remote-port', 'Model server port', { type: 'number', required: true, hint: 'Port on the GPU instance, usually 8000.' });
remotePort.input.min = '1';
remotePort.input.max = '65535';
const model = field('model-id', 'Model ID (optional)', { placeholder: 'Auto-detect from server', hint: 'Leave empty if the server advertises one model.' });
const hostRow = element('div', 'field-grid host-grid');
hostRow.append(host.wrapper, port.wrapper);
const userRow = element('div', 'field-grid');
userRow.append(username.wrapper, remotePort.wrapper);

const advanced = element('details', 'advanced');
advanced.append(element('summary', '', 'Advanced connection & model options'));
const advancedBody = element('div', 'advanced-body');
const transportField = element('div', 'field');
const transportLabel = element('label', '', 'Connection type');
transportLabel.htmlFor = 'transport';
const transport = element('select');
transport.id = 'transport';
const httpOption = element('option', '', 'Direct HTTP / HTTPS');
httpOption.value = 'http';
const sshOption = element('option', '', 'SSH tunnel');
sshOption.value = 'ssh';
transport.append(httpOption, sshOption);
transportField.append(transportLabel, transport);
const sshFields = element('div', 'ssh-fields');
const passphrase = field('key-passphrase', 'SSH key passphrase (optional)', { type: 'password', placeholder: 'Optional' });
sshFields.append(hostRow, userRow, key.wrapper, passphrase.wrapper);
transport.addEventListener('change', () => {
  // Credentials belong to the selected connection, never carry them across transports.
  apiKey.input.value = '';
  passphrase.input.value = '';
  formError.hidden = true;
  updateTransportFields();
});
const context = field('context-window', 'Context window', { type: 'number', required: true });
context.input.min = '4096';
context.input.max = '1000000';
const maxTokens = field('max-tokens', 'Output token limit', { type: 'number', required: true });
maxTokens.input.min = '256';
maxTokens.input.max = '1000000';
const tokenRow = element('div', 'field-grid');
tokenRow.append(context.wrapper, maxTokens.wrapper);
const reasoningLabel = element('label', 'checkbox-label');
const reasoning = element('input');
reasoning.type = 'checkbox';
reasoning.id = 'reasoning';
reasoningLabel.append(reasoning, document.createTextNode('Enable model reasoning'));
const secretNote = element('p', 'hint', 'Credentials are stored in VS Code Secret Storage. Leave blank to keep a saved value.');
advancedBody.append(transportField, sshFields, tokenRow, reasoningLabel, secretNote);
advanced.append(advancedBody);

const formError = element('p', 'form-error');
formError.hidden = true;
formError.setAttribute('role', 'alert');
const connectionActions = element('div', 'button-row');
const connect = element('button', 'button primary', 'Connect');
connect.type = 'submit';
const save = button('Save settings', () => submitProfile('saveProfile'));
const disconnect = button('Disconnect', () => send({ type: 'disconnect' }));
disconnect.hidden = true;
connectionActions.append(connect, disconnect, save);
connectionForm.append(apiAddress.wrapper, apiKey.wrapper, model.wrapper, advanced, formError, connectionActions);
connectionForm.addEventListener('submit', event => {
  event.preventDefault();
  submitProfile('connect');
});
connectionForm.addEventListener('input', () => { formError.hidden = true; updateTransportFields(); });
const gpuNote = element('p', 'hint gpu-note', 'Start and stop your GPU in Vast.ai. Disconnecting here does not stop GPU billing.');
connectionBody.append(connectionMessage, connectionForm, gpuNote);
connectionPanel.append(connectionSummary, connectionBody);

const sessionBar = element('div', 'session-bar');
const workspace = element('span', 'workspace', 'No folder open');
const sessionActions = element('div', 'session-actions');
const newSession = button('New', () => send({ type: 'newSession' }), 'button quiet compact');
newSession.title = 'Start a new conversation';
const resumeSession = button('Resume', () => send({ type: 'resumeSession' }), 'button quiet compact');
resumeSession.title = 'Resume the last saved conversation';
sessionActions.append(newSession, resumeSession);
sessionBar.append(workspace, sessionActions);

const transcript = element('main', 'transcript');
transcript.setAttribute('aria-label', 'Conversation');
const empty = element('div', 'empty-state');
const emptyEyebrow = element('p', 'eyebrow', 'YOUR WORKSPACE. YOUR MODEL.');
const emptyTitle = element('h2', '', 'Ready when you are.');
const emptyDescription = element('p', '', 'Connect your model server to start a coding task.');
const emptyHint = element('p', 'hint', 'Ask for a plan, fix a bug, or work through a change.');
empty.append(emptyEyebrow, emptyTitle, emptyDescription, emptyHint);
transcript.append(empty);
const entryNodes = new Map<string, { wrapper: HTMLElement; body: HTMLElement; label: HTMLElement; status?: HTMLElement }>();

const approvalPanel = element('section', 'approval-panel');
approvalPanel.hidden = true;
approvalPanel.setAttribute('aria-label', 'Tool approval');
const approvalAnnouncement = element('div', 'sr-only');
approvalAnnouncement.setAttribute('role', 'status');
approvalAnnouncement.setAttribute('aria-live', 'polite');

const changesPanel = element('details', 'changes-panel');
changesPanel.hidden = true;
const changesSummary = element('summary', '', 'Changed files');
const changesList = element('ul', 'changes-list');
changesPanel.append(changesSummary, changesList);
let lastChanges = '';

const composer = element('form', 'composer');
const composerTop = element('div', 'composer-top');
const modeLabel = element('label', 'sr-only', 'Agent mode');
modeLabel.htmlFor = 'agent-mode';
const mode = element('select', 'mode-select');
mode.id = 'agent-mode';
const planOption = element('option', '', 'Plan');
planOption.value = 'plan';
const agentOption = element('option', '', 'Agent');
agentOption.value = 'agent';
mode.append(planOption, agentOption);
mode.addEventListener('change', () => send({ type: 'mode', mode: mode.value as AgentMode }));
const modeDescription = element('span', 'hint', 'Read and propose changes');
composerTop.append(modeLabel, mode, modeDescription);
const promptLabel = element('label', 'sr-only', 'Coding task');
promptLabel.htmlFor = 'prompt';
const prompt = element('textarea', 'prompt');
prompt.id = 'prompt';
prompt.rows = 3;
prompt.placeholder = 'Describe a coding task…';
prompt.setAttribute('aria-describedby', 'composer-help');
const composerBottom = element('div', 'composer-bottom');
const composerHelp = element('span', 'hint', 'Enter to send · Shift+Enter for a new line');
composerHelp.id = 'composer-help';
const sendButton = element('button', 'button primary', 'Send');
sendButton.type = 'submit';
const stopButton = button('Stop', () => send({ type: 'abort' }), 'button secondary');
stopButton.hidden = true;
composerBottom.append(composerHelp, stopButton, sendButton);
composer.append(composerTop, promptLabel, prompt, composerBottom);
composer.addEventListener('submit', event => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text || !state || state.connection !== 'ready' || !state.workspaceName || state.agentStatus !== 'idle' || submitted) return;
  submitted = true;
  submittedEntryCount = state.entries.length;
  send({ type: 'prompt', text });
  prompt.value = '';
  updateComposer();
});
prompt.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});
prompt.addEventListener('input', updateComposer);
const footer = element('footer', 'app-footer');
const activity = element('span', '', 'Open a folder to get started');
activity.setAttribute('role', 'status');
activity.setAttribute('aria-live', 'polite');
const sessionIndicator = element('span', 'session-indicator');
footer.append(activity, sessionIndicator);
root.append(header, connectionPanel, sessionBar, transcript, approvalAnnouncement, approvalPanel, changesPanel, composer, footer);

function submitProfile(type: 'connect' | 'saveProfile'): void {
  // Reveal invalid fields before native validation tries to focus them.
  if (!context.input.validity.valid || !maxTokens.input.validity.valid) advanced.open = true;
  if (!connectionForm.reportValidity()) return;
  const profile: ConnectionProfile = {
    transport: transport.value === 'ssh' ? 'ssh' : 'http', baseUrl: apiAddress.input.value.trim(),
    host: host.input.value.trim(), port: Number(port.input.value), username: username.input.value.trim(),
    privateKeyPath: key.input.value.trim(), remotePort: Number(remotePort.input.value), model: model.input.value.trim(),
    contextWindow: Number(context.input.value), maxTokens: Number(maxTokens.input.value), reasoning: reasoning.checked,
  };
  if (profile.transport === 'http' && !profile.baseUrl) {
    formError.textContent = 'Enter the vLLM API address.';
    formError.hidden = false;
    return;
  }
  if (profile.transport === 'ssh' && (!profile.host || !profile.username || !profile.privateKeyPath)) {
    formError.textContent = 'Enter an SSH host, username, and private key file.';
    formError.hidden = false;
    return;
  }
  if (profile.maxTokens >= profile.contextWindow) {
    advanced.open = true;
    formError.textContent = 'The output token limit must be smaller than the context window.';
    formError.hidden = false;
    maxTokens.input.focus();
    return;
  }
  send({ type, profile, ...(apiKey.input.value ? { apiKey: apiKey.input.value } : {}), ...(profile.transport === 'ssh' && passphrase.input.value ? { passphrase: passphrase.input.value } : {}) });
  apiKey.input.value = '';
  passphrase.input.value = '';
  formError.hidden = true;
}

function updateProfile(profile: ConnectionProfile): void {
  const fields: [keyof ConnectionProfile, HTMLInputElement][] = [
    ['baseUrl', apiAddress.input],
    ['host', host.input], ['port', port.input], ['username', username.input], ['privateKeyPath', key.input],
    ['remotePort', remotePort.input], ['model', model.input], ['contextWindow', context.input], ['maxTokens', maxTokens.input],
  ];
  for (const [name, input] of fields) {
    if (!lastProfile || lastProfile[name] !== profile[name]) input.value = String(profile[name]);
  }
  if (!lastProfile || lastProfile.transport !== profile.transport) {
    transport.value = profile.transport;
    if (profile.transport === 'ssh') advanced.open = true;
  }
  if (!lastProfile || lastProfile.reasoning !== profile.reasoning) reasoning.checked = profile.reasoning;
  lastProfile = { ...profile };
  updateTransportFields();
}

function updateTransportFields(): void {
  const isSsh = transport.value === 'ssh';
  const locked = state?.connection === 'connecting' || state?.connection === 'ready';
  apiAddress.wrapper.hidden = isSsh;
  apiAddress.input.required = !isSsh;
  apiAddress.input.disabled = locked || isSsh;
  sshFields.hidden = !isSsh;
  for (const input of [host.input, port.input, username.input, key.input, remotePort.input]) input.required = isSsh;
  sshFields.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.disabled = locked || !isSsh; });
  browse.disabled = locked || !isSsh;
  transport.disabled = locked;
  const address = apiAddress.input.value.trim();
  httpNote.hidden = isSsh || !address || /^https:\/\//i.test(address);
  if (state?.workspaceName && state.connection !== 'ready') {
    emptyDescription.textContent = isSsh ? 'Enter the SSH details for your running GPU instance above.' : 'Enter your model’s API address above to connect.';
  }
  const matchesSaved = state?.profile.transport === transport.value && (isSsh
    ? state.profile.host === host.input.value.trim() && state.profile.port === Number(port.input.value)
      && state.profile.username === username.input.value.trim() && state.profile.privateKeyPath === key.input.value.trim()
    : state.profile.baseUrl === address);
  apiKey.input.placeholder = matchesSaved && state?.hasApiKey ? 'Saved · leave blank to keep' : 'Optional';
  passphrase.input.placeholder = matchesSaved && state?.hasPassphrase ? 'Saved · leave blank to keep' : 'Optional';
}

function renderEntry(entry: ChatEntry) {
  let nodes = entryNodes.get(entry.id);
  if (!nodes) {
    if (entry.role === 'tool') {
      const wrapper = element('details', 'entry tool-entry');
      const summary = element('summary', 'tool-summary');
      const label = element('span', 'tool-name');
      const status = element('span', 'tool-status');
      summary.append(label, status);
      const body = element('pre', 'tool-output');
      body.tabIndex = 0;
      body.setAttribute('aria-label', 'Tool input and output');
      wrapper.append(summary, body);
      nodes = { wrapper, label, body, status };
    } else {
      const wrapper = element('article', `entry ${entry.role}-entry`);
      const label = element('div', 'entry-label');
      const body = element('div', 'message-text');
      wrapper.append(label, body);
      nodes = { wrapper, label, body };
    }
    entryNodes.set(entry.id, nodes);
  }
  const label = entry.role === 'user' ? 'You' : entry.role === 'assistant' ? 'Open Anchor' : entry.role === 'tool' ? (entry.toolName ?? 'Tool') : 'Session';
  if (nodes.label.textContent !== label) nodes.label.textContent = label;
  if (nodes.body.textContent !== entry.text) nodes.body.textContent = entry.text;
  if (nodes.status) {
    nodes.status.textContent = entry.status === 'running' ? 'Running' : entry.status === 'error' ? 'Failed' : 'Done';
    nodes.wrapper.dataset.status = entry.status ?? 'done';
  }
  return nodes.wrapper;
}

function updateTranscript(next: ViewState): void {
  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60;
  const existingIds = new Set(next.entries.map(entry => entry.id));
  for (const [id, nodes] of entryNodes) {
    if (!existingIds.has(id)) { nodes.wrapper.remove(); entryNodes.delete(id); }
  }
  empty.hidden = next.entries.length > 0;
  emptyTitle.textContent = !next.workspaceName ? 'Open a project folder.' : next.connection === 'ready' ? 'What are we building?' : 'Connect your coding agent.';
  emptyDescription.textContent = !next.workspaceName
    ? 'Open a folder in VS Code so the agent can read and work with your project.'
    : next.connection === 'ready'
      ? 'Your model is connected. Start with a question or describe a change.'
      : transport.value === 'ssh' ? 'Enter the SSH details for your running GPU instance above.' : 'Enter your model’s API address above to connect.';
  for (let index = 0; index < next.entries.length; index++) {
    const node = renderEntry(next.entries[index]);
    const expected = transcript.children[index + 1]; // Empty state remains the first node.
    if (expected !== node) transcript.insertBefore(node, expected ?? null);
  }
  if (!next.entries.length) transcript.scrollTop = 0;
  else if (atBottom) transcript.scrollTop = transcript.scrollHeight;
}

function updateApproval(next: ViewState): void {
  if (!next.approval) {
    approvalPanel.hidden = true;
    approvalId = undefined;
    approvalAnnouncement.textContent = '';
    return;
  }
  approvalPanel.hidden = false;
  if (approvalId === next.approval.id) return;
  approvalId = next.approval.id;
  const request = next.approval;
  const title = element('h2', '', 'Approval needed');
  const description = element('p', 'approval-description', `Allow ${request.toolName} in this workspace?`);
  const details = element('details', 'approval-details');
  details.open = true;
  const input = element('pre', 'approval-input', JSON.stringify(request.input, null, 2));
  input.tabIndex = 0;
  details.append(element('summary', '', 'Tool input'), input);
  const actions = element('div', 'button-row');
  const decide = (approved: boolean) => {
    allow.disabled = true;
    deny.disabled = true;
    send({ type: 'approve', id: request.id, approved });
  };
  const allow = button('Approve once', () => decide(true), 'button primary');
  const deny = button('Deny', () => decide(false));
  actions.append(allow, deny);
  approvalPanel.replaceChildren(title, description, details, actions);
  approvalAnnouncement.textContent = `Approval needed for ${request.toolName}. Review its input and choose Approve once or Deny.`;
}

function updateChanges(next: ViewState): void {
  changesPanel.hidden = !next.changes.length;
  changesSummary.textContent = `Changed files · ${next.changes.length}`;
  const signature = JSON.stringify(next.changes);
  if (signature !== lastChanges) {
    lastChanges = signature;
    changesList.replaceChildren(...next.changes.map(path => {
      const row = element('li', 'changed-file');
      const name = element('span', 'file-path', path);
      name.title = path;
      const actions = element('div', 'file-actions');
      const review = button('Review', () => send({ type: 'reviewFile', path }), 'button quiet compact');
      review.setAttribute('aria-label', `Review changes to ${path}`);
      const undo = button('Undo', () => send({ type: 'undoFile', path }), 'button quiet compact undo-file');
      undo.setAttribute('aria-label', `Undo agent changes to ${path}`);
      actions.append(review, undo);
      row.append(name, actions);
      return row;
    }));
  }
  changesList.querySelectorAll<HTMLButtonElement>('.undo-file').forEach(undo => { undo.disabled = next.agentStatus !== 'idle'; });
}

function updateComposer(): void {
  const ready = state?.connection === 'ready' && !!state.workspaceName;
  const busy = state?.agentStatus !== 'idle' && state !== undefined;
  prompt.disabled = !ready;
  prompt.placeholder = !state?.workspaceName ? 'Open a project folder to start…' : !ready ? 'Connect your model to start…' : 'Describe a coding task…';
  sendButton.disabled = !ready || busy || submitted || !prompt.value.trim();
  sendButton.hidden = busy || submitted;
  stopButton.hidden = !busy && !submitted;
  mode.disabled = busy || submitted;
  modeDescription.textContent = mode.value === 'plan' ? 'Read and propose changes' : 'Edit and run tools with approval';
}

function render(next: ViewState): void {
  const previous = state;
  state = next;
  if (next.agentStatus !== 'idle' || next.entries.length !== submittedEntryCount || next.connection !== 'ready') submitted = false;
  updateProfile(next.profile);
  root.dataset.connection = next.connection;
  statusLabel.textContent = next.connection === 'ready' ? 'Connected' : next.connection === 'connecting' ? 'Connecting…' : next.connection === 'error' ? 'Connection failed' : 'Not connected';
  connectionHint.textContent = next.connection === 'ready' ? next.profile.model || 'Model ready' : next.profile.transport === 'ssh' ? 'SSH settings' : 'API settings';
  connectionHint.title = next.profile.model;
  connectionMessage.textContent = next.connectionMessage;
  connectionMessage.hidden = !next.connectionMessage;
  connectionMessage.classList.toggle('error', next.connection === 'error');
  if (next.connection === 'ready' && previous?.connection !== 'ready') connectionPanel.open = false;
  if (next.connection === 'error') connectionPanel.open = true;
  connect.hidden = next.connection === 'ready';
  connect.disabled = next.connection === 'connecting';
  connect.textContent = next.connection === 'connecting' ? 'Connecting…' : 'Connect';
  disconnect.hidden = next.connection === 'disconnected' || next.connection === 'error';
  const profileLocked = next.connection === 'connecting' || next.connection === 'ready';
  save.disabled = profileLocked;
  browse.disabled = profileLocked;
  connectionForm.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.disabled = profileLocked; });
  updateTransportFields();
  workspace.textContent = next.workspaceName || 'No folder open';
  workspace.title = next.workspaceName || 'Open a folder in VS Code';
  newSession.disabled = !next.workspaceName || next.connection !== 'ready' || next.agentStatus !== 'idle' || submitted;
  resumeSession.disabled = !next.canResume || !next.workspaceName || next.connection !== 'ready' || next.agentStatus !== 'idle' || submitted;
  mode.value = next.mode;
  updateTranscript(next);
  updateApproval(next);
  updateChanges(next);
  updateComposer();
  activity.textContent = next.agentStatus === 'waitingApproval' ? 'Waiting for your approval' : next.agentStatus === 'running' ? 'Working…' : !next.workspaceName ? 'Open a folder to get started' : next.connection === 'ready' ? 'Ready' : next.connection === 'connecting' ? 'Connecting to model…' : 'Model disconnected';
  sessionIndicator.textContent = next.sessionId ? `Session ${next.sessionId.slice(0, 8)}` : '';
  sessionIndicator.title = next.sessionId ?? '';
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  if (event.data?.type === 'state') render(event.data.state);
});
updateProfile(DEFAULT_PROFILE);
updateComposer();
send({ type: 'ready' });
