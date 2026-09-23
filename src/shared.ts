export type AgentMode = 'plan' | 'agent';
export interface ConnectionProfile {
  transport: 'http' | 'ssh';
  baseUrl: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
  remotePort: number;
  model: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}
export const DEFAULT_PROFILE: ConnectionProfile = {
  transport: 'http', baseUrl: '',
  host: '', port: 22, username: 'root', privateKeyPath: '', remotePort: 8000,
  model: '', contextWindow: 32768, maxTokens: 8192, reasoning: true,
};
export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  toolName?: string;
  status?: 'running' | 'done' | 'error';
}
export interface ApprovalRequest { id: string; toolName: string; input: Record<string, unknown>; }
export interface ViewState {
  profile: ConnectionProfile;
  connection: 'disconnected' | 'connecting' | 'ready' | 'error';
  connectionMessage: string;
  agentStatus: 'idle' | 'running' | 'waitingApproval';
  mode: AgentMode;
  entries: ChatEntry[];
  approval?: ApprovalRequest;
  changes: string[];
  workspaceName: string;
  sessionId?: string;
  canResume: boolean;
  hasApiKey: boolean;
  hasPassphrase: boolean;
}
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'connect'; profile: ConnectionProfile; apiKey?: string; passphrase?: string }
  | { type: 'saveProfile'; profile: ConnectionProfile; apiKey?: string; passphrase?: string }
  | { type: 'selectKey' }
  | { type: 'disconnect' | 'abort' | 'newSession' | 'resumeSession' | 'showLogs' }
  | { type: 'prompt'; text: string }
  | { type: 'mode'; mode: AgentMode }
  | { type: 'approve'; id: string; approved: boolean }
  | { type: 'reviewFile' | 'undoFile'; path: string };
export type HostMessage = { type: 'state'; state: ViewState };
export interface WorkerConfig {
  cwd: string;
  sessionDir: string;
  sessionFile?: string;
  model: { id: string; baseUrl: string; apiKey: string; contextWindow: number; maxTokens: number; reasoning: boolean };
  mode: AgentMode;
}
export type WorkerCommand =
  | { type: 'init'; config: WorkerConfig }
  | { type: 'prompt'; text: string }
  | { type: 'abort' | 'shutdown' }
  | { type: 'mode'; mode: AgentMode }
  | { type: 'approval'; id: string; approved: boolean };
export type WorkerEvent =
  | { type: 'ready'; sessionId: string; sessionFile?: string; history: ChatEntry[] }
  | { type: 'text'; text: string }
  | { type: 'assistantEnd' }
  | { type: 'toolStart'; id: string; toolName: string; input: Record<string, unknown> }
  | { type: 'toolEnd'; id: string; toolName: string; text: string; isError: boolean }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'status'; text: string }
  | { type: 'idle' }
  | { type: 'error'; message: string; fatal?: boolean };
