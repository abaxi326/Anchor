import { DEFAULT_PROFILE, type ConnectionProfile } from '../shared';

/** Accept the exposed inference URL, including Vast proxy path prefixes. */
export function normalizeBaseUrl(input: string): string {
  const value = input.trim();
  if (!value || /[\s\\?#\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Enter the vLLM HTTP or HTTPS URL without spaces, query parameters, or fragments.');
  }
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  } catch { throw new Error('Enter a valid vLLM URL, such as http://IP:PORT or https://your-proxy-host.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS vLLM URL without embedded credentials, query parameters, or fragments.');
  }
  if (url.port === '0') throw new Error('The vLLM port must be between 1 and 65535.');
  const prefix = url.pathname.replace(/\/+$/, '');
  url.pathname = prefix.endsWith('/v1') ? prefix : `${prefix}/v1`;
  return url.href.replace(/\/$/, '');
}

/** Validate data arriving from the webview before using it for a connection. */
export function validateProfile(input: unknown): ConnectionProfile {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Connection settings must be an object.');
  }
  const raw = { ...DEFAULT_PROFILE, ...input } as Record<string, unknown>;
  const text = (name: keyof ConnectionProfile, required = false): string => {
    const value = raw[name];
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error(`${name} must be text without control characters.`);
    }
    const result = value.trim();
    if (required && !result) throw new Error(`${name} is required.`);
    if (result.length > 4096) throw new Error(`${name} is too long.`);
    return result;
  };
  const integer = (name: keyof ConnectionProfile, min: number, max: number): number => {
    const value = raw[name];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}.`);
    }
    return value;
  };
  const inactiveText = (name: 'host' | 'username' | 'privateKeyPath' | 'baseUrl'): string => {
    const value = raw[name];
    return typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)
      ? value.trim() : DEFAULT_PROFILE[name];
  };
  const inactivePort = (name: 'port' | 'remotePort'): number => {
    const value = raw[name];
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
      ? value : DEFAULT_PROFILE[name];
  };
  if (raw.transport !== 'http' && raw.transport !== 'ssh') throw new Error('Choose a direct HTTP connection or SSH tunnel.');
  const ssh = raw.transport === 'ssh';
  const host = (ssh ? text('host', true) : inactiveText('host')).replace(/^\[([^\]]+)\]$/, '$1');
  if (ssh && (/[\s/@\\?#]/.test(host) || host.includes('://'))) {
    throw new Error('host must be a hostname or IP address, without a URL or SSH command.');
  }
  const username = ssh ? text('username', true) : inactiveText('username');
  if (ssh && /\s/.test(username)) throw new Error('username must not contain whitespace.');
  const contextWindow = integer('contextWindow', 4096, 1048576);
  const maxTokens = integer('maxTokens', 256, contextWindow - 1);
  if (typeof raw.reasoning !== 'boolean') throw new Error('reasoning must be true or false.');
  return {
    transport: raw.transport,
    baseUrl: ssh ? inactiveText('baseUrl') : normalizeBaseUrl(text('baseUrl', true)),
    host,
    port: ssh ? integer('port', 1, 65535) : inactivePort('port'),
    username,
    privateKeyPath: ssh ? text('privateKeyPath', true) : inactiveText('privateKeyPath'),
    remotePort: ssh ? integer('remotePort', 1, 65535) : inactivePort('remotePort'),
    model: text('model'),
    contextWindow,
    maxTokens,
    reasoning: raw.reasoning,
  };
}
