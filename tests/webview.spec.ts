import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { DEFAULT_PROFILE, type ViewState, type WebviewMessage } from '../src/shared';

type TestWindow = Window & {
  acquireVsCodeApi: () => { postMessage: (message: WebviewMessage) => void };
  hostMessages: WebviewMessage[];
};

let script: string;
let styles: string;
const profile = { ...DEFAULT_PROFILE, baseUrl: 'https://model-proxy.example.test' };
const sshProfile = { ...profile, transport: 'ssh' as const, host: 'gpu.example.test', privateKeyPath: 'C:\\keys\\gpu_key' };
const snapshot = (overrides: Partial<ViewState> = {}): ViewState => ({
  profile, connection: 'disconnected', connectionMessage: 'Connect to your running GPU to begin.',
  agentStatus: 'idle', mode: 'plan', entries: [], changes: [], workspaceName: 'sample-project',
  canResume: false, hasApiKey: false, hasPassphrase: false, ...overrides,
});

test.beforeAll(async () => {
  const result = await build({ entryPoints: ['src/webview/main.ts'], bundle: true, write: false,
    outdir: 'test-webview-build', platform: 'browser', format: 'iife', target: 'es2022' });
  script = result.outputFiles!.find(file => file.path.endsWith('.js'))!.text;
  styles = await readFile('src/webview/style.css', 'utf8');
});

async function hostState(page: Page, next: ViewState) {
  await page.evaluate(state => window.postMessage({ type: 'state', state }, '*'), next);
  await expect(page.locator('#root')).toHaveAttribute('data-connection', next.connection);
}

async function messages(page: Page) {
  return page.evaluate(() => (window as unknown as TestWindow).hostMessages);
}

async function mount(page: Page, initial = snapshot()) {
  await page.setContent('<!DOCTYPE html><html lang="en"><body><div id="root"></div></body></html>');
  await page.evaluate(() => {
    const fixtureWindow = window as unknown as TestWindow;
    fixtureWindow.hostMessages = [];
    fixtureWindow.acquireVsCodeApi = () => ({ postMessage: message => fixtureWindow.hostMessages.push(message) });
  });
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await hostState(page, initial);
}

test('disconnected and no-workspace states explain what is needed', async ({ page }) => {
  await mount(page, snapshot({ workspaceName: '' }));
  await expect(page.getByRole('heading', { name: 'Open a project folder.' })).toBeVisible();
  await expect(page.getByLabel('Coding task')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
  expect(await messages(page)).toContainEqual({ type: 'ready' });
  await hostState(page, snapshot());
  await expect(page.getByRole('heading', { name: 'Connect your coding agent.' })).toBeVisible();
  await expect(page.getByLabel('Coding task')).toBeDisabled();
  await expect(page.getByText('Disconnecting here does not stop GPU billing.', { exact: false })).toBeVisible();
});

test('direct API connection needs no SSH settings and clears its masked key immediately', async ({ page }) => {
  await mount(page);
  await expect(page.getByLabel('API address', { exact: true })).toBeVisible();
  await expect(page.getByLabel('SSH host', { exact: true })).toBeHidden();
  await expect(page.getByLabel('SSH host', { exact: true })).not.toHaveAttribute('required', '');
  await page.getByLabel('Model API key (optional)', { exact: true }).fill('test-api-key');
  await expect(page.getByLabel('Model API key (optional)', { exact: true })).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  expect(await messages(page)).toContainEqual({ type: 'connect', profile, apiKey: 'test-api-key' });
  await expect(page.getByLabel('Model API key (optional)', { exact: true })).toHaveValue('');
  await hostState(page, snapshot({ connection: 'connecting' }));
  await expect(page.getByLabel('API address', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Connecting…', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
  await hostState(page, snapshot({ connection: 'ready', hasApiKey: true, hasPassphrase: true }));
  await expect(page.getByLabel('Coding task')).toBeEnabled();
  await page.locator('.connection-summary').click();
  await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Model API key (optional)', { exact: true })).toHaveAttribute('placeholder', 'Saved · leave blank to keep');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  expect(await messages(page)).toContainEqual({ type: 'disconnect' });
});

test('API address accepts IP:port and optional fields can remain empty', async ({ page }) => {
  await mount(page);
  await page.getByLabel('API address', { exact: true }).fill('203.0.113.10:18432');
  await expect(page.getByText('HTTP sends requests without encryption.', { exact: false })).toBeVisible();
  await expect(page.getByText('Use the vLLM HTTP address from Vast.ai:', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  expect(await messages(page)).toContainEqual({ type: 'connect', profile: { ...profile, baseUrl: '203.0.113.10:18432' } });
});

test('optional SSH tunnel retains endpoint drafts but clears credentials on transport change', async ({ page }) => {
  await mount(page);
  await page.getByText('Advanced connection & model options', { exact: true }).click();
  await page.getByLabel('Connection type', { exact: true }).selectOption('ssh');
  await expect(page.getByLabel('API address', { exact: true })).toBeHidden();
  await expect(page.getByLabel('API address', { exact: true })).not.toHaveAttribute('required', '');
  await page.getByLabel('SSH host', { exact: true }).fill(sshProfile.host);
  await page.getByLabel('Private key file', { exact: true }).fill(sshProfile.privateKeyPath);
  await page.getByLabel('Model API key (optional)', { exact: true }).fill('ssh-api-key');
  await page.getByLabel('SSH key passphrase (optional)', { exact: true }).fill('ssh-passphrase');
  await page.getByLabel('Connection type', { exact: true }).selectOption('http');
  await expect(page.getByLabel('API address', { exact: true })).toHaveValue(profile.baseUrl);
  await expect(page.getByLabel('Model API key (optional)', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('SSH key passphrase (optional)', { exact: true })).toHaveValue('');
  await page.getByLabel('Connection type', { exact: true }).selectOption('ssh');
  await expect(page.getByLabel('SSH host', { exact: true })).toHaveValue(sshProfile.host);
  await expect(page.getByLabel('Private key file', { exact: true })).toHaveValue(sshProfile.privateKeyPath);
  await page.getByLabel('Model API key (optional)', { exact: true }).fill('ssh-api-key');
  await page.getByLabel('SSH key passphrase (optional)', { exact: true }).fill('ssh-passphrase');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  expect(await messages(page)).toContainEqual({ type: 'connect', profile: sshProfile, apiKey: 'ssh-api-key', passphrase: 'ssh-passphrase' });
  await expect(page.getByLabel('Model API key (optional)', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('SSH key passphrase (optional)', { exact: true })).toHaveValue('');
});

test('restoring an SSH profile opens its settings and credential indicators track the endpoint', async ({ page }) => {
  await mount(page, snapshot({ profile: sshProfile, hasApiKey: true, hasPassphrase: true }));
  await expect(page.getByLabel('SSH host', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Model API key (optional)', { exact: true })).toHaveAttribute('placeholder', 'Saved · leave blank to keep');
  await page.getByLabel('SSH host', { exact: true }).fill('another-gpu.example.test');
  await expect(page.getByLabel('Model API key (optional)', { exact: true })).toHaveAttribute('placeholder', 'Optional');
  await expect(page.getByLabel('SSH key passphrase (optional)', { exact: true })).toHaveAttribute('placeholder', 'Optional');
});

test('drafts, focus, and expanded tool cards survive streaming state snapshots', async ({ page }) => {
  const running = snapshot({ connection: 'ready', agentStatus: 'running', entries: [
    { id: 'assistant-1', role: 'assistant', text: 'Inspecting ' },
    { id: 'tool-1', role: 'tool', toolName: 'read', text: '{"path":"src/app.ts"}', status: 'running' },
  ] });
  await mount(page, running);
  await page.locator('.tool-summary').click();
  const input = page.getByLabel('Coding task');
  await input.fill('My next task is still a draft');
  await input.focus();
  for (const text of ['Inspecting the', 'Inspecting the project', 'Inspecting the project now.']) {
    await hostState(page, { ...running, entries: [{ ...running.entries[0], text }, running.entries[1]] });
    await expect(page.locator('.assistant-entry .message-text')).toHaveText(text);
    await expect(input).toHaveValue('My next task is still a draft');
    await expect(input).toBeFocused();
    await expect(page.locator('.tool-entry')).toHaveAttribute('open', '');
  }
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  expect(await messages(page)).toContainEqual({ type: 'abort' });
});

test('Enter submits once and Shift+Enter preserves a multiline draft', async ({ page }) => {
  await mount(page, snapshot({ connection: 'ready' }));
  const input = page.getByLabel('Coding task');
  await input.fill('Fix this bug');
  await input.press('Shift+Enter');
  await input.press('x');
  await expect(input).toHaveValue('Fix this bug\nx');
  await input.press('Enter');
  await input.press('Enter');
  expect((await messages(page)).filter(message => message.type === 'prompt')).toEqual([{ type: 'prompt', text: 'Fix this bug\nx' }]);
  await expect(input).toHaveValue('');
});

test('approval requires an explicit decision and displays tool input as plain text', async ({ page }) => {
  const approval = { id: 'approval-1', toolName: 'bash', input: { command: '<img src=x onerror="window.injected=true">' } };
  const waiting = snapshot({ connection: 'ready', agentStatus: 'waitingApproval', approval });
  await mount(page, waiting);
  await expect(page.getByRole('heading', { name: 'Approval needed' })).toBeVisible();
  await expect(page.locator('.approval-input')).toContainText('<img');
  expect(await page.locator('.approval-input img').count()).toBe(0);
  await page.getByRole('button', { name: 'Approve once', exact: true }).click();
  expect(await messages(page)).toContainEqual({ type: 'approve', id: 'approval-1', approved: true });
  await expect(page.getByRole('button', { name: 'Approve once', exact: true })).toBeDisabled();
  await hostState(page, { ...waiting, approval: { ...approval, id: 'approval-2' } });
  await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  expect(await messages(page)).toContainEqual({ type: 'approve', id: 'approval-2', approved: false });
  await hostState(page, snapshot({ connection: 'ready' }));
  await expect(page.getByRole('heading', { name: 'Approval needed' })).toBeHidden();
});

test('session and file controls emit scoped messages and lock undo during a task', async ({ page }) => {
  const ready = snapshot({ connection: 'ready', canResume: true, changes: ['src/app.ts'] });
  await mount(page, ready);
  await page.getByLabel('Agent mode').selectOption('agent');
  expect(await messages(page)).toContainEqual({ type: 'mode', mode: 'agent' });
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.locator('.changes-panel > summary').click();
  await page.getByRole('button', { name: 'Review changes to src/app.ts', exact: true }).click();
  await page.getByRole('button', { name: 'Undo agent changes to src/app.ts', exact: true }).click();
  const sent = await messages(page);
  expect(sent).toContainEqual({ type: 'newSession' });
  expect(sent).toContainEqual({ type: 'resumeSession' });
  expect(sent).toContainEqual({ type: 'reviewFile', path: 'src/app.ts' });
  expect(sent).toContainEqual({ type: 'undoFile', path: 'src/app.ts' });
  await hostState(page, { ...ready, agentStatus: 'running' });
  await expect(page.getByRole('button', { name: 'Undo agent changes to src/app.ts', exact: true })).toBeDisabled();
});

test('untrusted transcript is inert and a narrow sidebar does not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 220, height: 720 });
  const malicious = '<img src=x onerror="window.injected=true"><script>window.injected=true</script>';
  await mount(page, snapshot({ connection: 'ready', entries: [
    { id: 'bad', role: 'assistant', text: malicious + 'very-long-text'.repeat(50) },
  ] }));
  await expect(page.locator('.message-text')).toContainText(malicious);
  expect(await page.locator('.transcript img, .transcript script').count()).toBe(0);
  expect(await page.evaluate(() => 'injected' in window)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(220);
});

test('capture connection and ready sidebar visual fixtures', async ({ page }) => {
  await mkdir('.test-artifacts', { recursive: true });
  await page.setViewportSize({ width: 360, height: 900 });
  await mount(page);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: '.test-artifacts/sidebar-connection.png', animations: 'disabled' });
  await hostState(page, snapshot({ profile: sshProfile }));
  await expect(page.getByLabel('SSH host', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 1200 });
  await page.screenshot({ path: '.test-artifacts/sidebar-ssh.png', animations: 'disabled' });
  await page.setViewportSize({ width: 360, height: 900 });
  await hostState(page, snapshot({
    connection: 'ready', connectionMessage: 'Connected · Qwen3.8-27B',
    profile: { ...profile, model: 'Qwen3.8-27B' }, canResume: true, sessionId: '83af4978-example',
    entries: [
      { id: 'user-1', role: 'user', text: 'Find why the connection status stays busy after an error, and suggest a fix.' },
      { id: 'tool-1', role: 'tool', toolName: 'read', text: 'src/connection.ts\n\nConnection state is reset only on the success path.', status: 'done' },
      { id: 'assistant-1', role: 'assistant', text: 'The error path returns before resetting the connection state. Move that reset into a finally block so both success and failure return the interface to idle.\n\nI can make this change and add a regression test when you switch to Agent mode.' },
    ],
  }));
  await expect(page.locator('.assistant-entry')).toBeVisible();
  await page.screenshot({ path: '.test-artifacts/sidebar-ready.png', animations: 'disabled' });
});
