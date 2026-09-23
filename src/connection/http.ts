import type { ConnectionProfile } from '../shared';
import { connectionCancelled, discoverModel } from './models';
import { validateProfile } from './validation';

interface HttpConnectionOptions {
  log?: (message: string) => void;
  onClose?: (error?: Error) => void;
}

/** Verifies a directly exposed vLLM endpoint without SSH or cloud lifecycle operations. */
export class HttpConnection {
  private pending?: AbortController;
  private generation = 0;

  constructor(private readonly options: HttpConnectionOptions = {}) {}

  async connect(
    input: ConnectionProfile,
    secrets: { apiKey?: string; passphrase?: string },
    signal?: AbortSignal,
  ): Promise<{ baseUrl: string; model: string }> {
    const profile = validateProfile(input);
    if (profile.transport !== 'http') throw new Error('Choose direct HTTP to connect using a vLLM URL.');
    if (signal?.aborted) throw connectionCancelled();
    const generation = ++this.generation;
    this.pending?.abort();
    const pending = new AbortController();
    this.pending = pending;
    const abort = () => pending.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      this.options.log?.('Checking the configured vLLM endpoint.');
      const model = await discoverModel(profile.baseUrl, profile.model, secrets.apiKey, pending.signal);
      if (generation !== this.generation || pending.signal.aborted) throw connectionCancelled();
      this.options.log?.('The vLLM endpoint is ready.');
      return { baseUrl: profile.baseUrl, model };
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.pending === pending) this.pending = undefined;
    }
  }

  async disconnect(): Promise<void> {
    ++this.generation;
    this.pending?.abort();
    this.pending = undefined;
  }
}
