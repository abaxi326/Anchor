import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client, type ClientChannel } from 'ssh2';
import type { ConnectionProfile } from '../shared';
import { validateProfile } from './validation';
import { discoverModel } from './models';

interface ConnectionOptions {
  onHostKey: (host: string, port: number, fingerprint: string) => Promise<boolean>;
  onClose: (error?: Error) => void;
  log: (message: string) => void;
}
interface Session {
  client: Client;
  server?: Server;
  sockets: Set<Socket>;
  channels: Set<ClientChannel>;
  abort: AbortController;
  closing: boolean;
  ready: boolean;
  removeAbort?: () => void;
  closed?: Promise<void>;
}

function cancelled(): Error {
  const error = new Error('Connection cancelled.');
  error.name = 'AbortError';
  return error;
}

/** Owns only an SSH connection and a local tunnel. Never changes the remote machine. */
export class SshConnection {
  private session?: Session;
  private generation = 0;

  constructor(private readonly options: ConnectionOptions) {}

  async connect(
    input: ConnectionProfile,
    secrets: { passphrase?: string; apiKey?: string },
    signal?: AbortSignal,
  ): Promise<{ baseUrl: string; model: string }> {
    const profile = validateProfile(input);
    if (profile.transport !== 'ssh') throw new Error('Choose SSH tunnel to connect using an SSH host and private key.');
    if (signal?.aborted) throw cancelled();
    const generation = ++this.generation;
    const old = this.session;
    this.session = undefined;
    if (old) await this.closeSession(old);
    if (generation !== this.generation || signal?.aborted) throw cancelled();

    const session: Session = {
      client: new Client(), sockets: new Set(), channels: new Set(),
      abort: new AbortController(), closing: false, ready: false,
    };
    this.session = session;
    const abort = () => { void this.closeSession(session); };
    signal?.addEventListener('abort', abort, { once: true });
    session.removeAbort = () => signal?.removeEventListener('abort', abort);

    // Keep an error handler installed for the entire lifetime, including shutdown.
    session.client.on('error', (error: Error & { level?: string }) => {
      const message = error.level === 'client-authentication'
        ? 'SSH authentication failed. Check the username, private key, and passphrase.'
        : 'The SSH connection failed. Check the endpoint and network connection.';
      if (session.ready) this.connectionLost(session, new Error(message));
    });
    session.client.on('close', () => {
      if (session.ready) this.connectionLost(session, new Error('The SSH connection closed. Reconnect to continue.'));
      else if (!session.closing) void this.closeSession(session);
    });

    try {
      const keyPath = /^~[/\\]/.test(profile.privateKeyPath)
        ? join(homedir(), profile.privateKeyPath.slice(2)) : profile.privateKeyPath;
      let privateKey: Buffer;
      try {
        privateKey = await readFile(keyPath, { signal: session.abort.signal });
      } catch {
        if (session.abort.signal.aborted) throw cancelled();
        throw new Error('Cannot read the SSH private key. Select an existing private-key file.');
      }
      if (privateKey.length > 1024 * 1024) throw new Error('The selected SSH private-key file is too large.');
      this.checkActive(session, generation);
      this.options.log('Connecting to the configured SSH endpoint.');
      await this.openSsh(session, profile, privateKey, secrets.passphrase);
      this.checkActive(session, generation);
      const port = await this.openForwarder(session, profile.remotePort);
      this.checkActive(session, generation);
      const baseUrl = `http://127.0.0.1:${port}/v1`;
      const model = await discoverModel(baseUrl, profile.model, secrets.apiKey, session.abort.signal);
      this.checkActive(session, generation);
      session.ready = true;
      this.options.log('SSH tunnel and model endpoint are ready.');
      return { baseUrl, model };
    } catch (error) {
      await this.closeSession(session);
      if (this.session === session) this.session = undefined;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    ++this.generation;
    const session = this.session;
    this.session = undefined;
    if (session) await this.closeSession(session);
  }

  private checkActive(session: Session, generation: number): void {
    if (session.closing || generation !== this.generation) throw cancelled();
  }

  private openSsh(session: Session, profile: ConnectionProfile, privateKey: Buffer, passphrase?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let hostDenied = false;
      let hostError: Error | undefined;
      const cleanup = () => {
        session.client.removeListener('ready', ready);
        session.client.removeListener('error', failed);
        session.client.removeListener('close', closed);
        session.abort.signal.removeEventListener('abort', aborted);
      };
      const ready = () => { cleanup(); resolve(); };
      const failed = (error: Error & { level?: string }) => {
        cleanup();
        reject(hostError ?? new Error(hostDenied ? 'The SSH host key was not approved.'
          : error.level === 'client-authentication'
            ? 'SSH authentication failed. Check the username, private key, and passphrase.'
            : 'SSH connection failed. Check the endpoint, private key, and network connection.'));
      };
      const closed = () => { cleanup(); reject(new Error('SSH closed before the connection was ready.')); };
      const aborted = () => { cleanup(); reject(cancelled()); };
      session.client.once('ready', ready);
      session.client.once('error', failed);
      session.client.once('close', closed);
      session.abort.signal.addEventListener('abort', aborted, { once: true });
      if (session.abort.signal.aborted) { aborted(); return; }
      try {
        session.client.connect({
          host: profile.host, port: profile.port, username: profile.username,
          privateKey, passphrase, authHandler: ['publickey'],
          readyTimeout: 90000, keepaliveInterval: 15000, keepaliveCountMax: 3,
          hostVerifier: (key: Buffer, verify: (accepted: boolean) => void) => {
            const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
            void Promise.resolve().then(() => this.options.onHostKey(profile.host, profile.port, fingerprint)).then(
              accepted => {
                hostDenied = !accepted;
                if (!session.closing) verify(accepted);
              },
              error => {
                hostDenied = true;
                // This comes from the trusted extension callback, not the remote server.
                // Preserve its host-key mismatch/remediation message for the user.
                if (error instanceof Error) hostError = error;
                if (!session.closing) verify(false);
              },
            );
          },
        });
      } catch {
        cleanup();
        reject(new Error('Cannot initialize SSH. Check the private-key format and passphrase.'));
      }
    });
  }

  private openForwarder(session: Session, remotePort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer(socket => {
        if (session.closing) { socket.destroy(); return; }
        session.sockets.add(socket);
        socket.on('error', () => socket.destroy());
        socket.once('close', () => session.sockets.delete(socket));
        socket.pause();
        session.client.forwardOut('127.0.0.1', socket.remotePort ?? 0, '127.0.0.1', remotePort, (error, channel) => {
          if (error || session.closing || socket.destroyed) {
            channel?.destroy(); socket.destroy(); return;
          }
          session.channels.add(channel);
          channel.on('error', () => { channel.destroy(); socket.destroy(); });
          channel.once('close', () => { session.channels.delete(channel); socket.destroy(); });
          socket.once('close', () => channel.destroy());
          socket.pipe(channel).pipe(socket);
          socket.resume();
        });
      });
      session.server = server;
      const failed = () => { cleanup(); reject(new Error('Cannot open the local SSH tunnel.')); };
      const aborted = () => { cleanup(); reject(cancelled()); };
      const cleanup = () => {
        server.removeListener('error', failed);
        session.abort.signal.removeEventListener('abort', aborted);
      };
      server.once('error', failed);
      server.on('error', () => {
        if (session.ready) this.connectionLost(session, new Error('The local SSH tunnel failed.'));
      });
      session.abort.signal.addEventListener('abort', aborted, { once: true });
      if (session.abort.signal.aborted) { aborted(); return; }
      server.listen({ host: '127.0.0.1', port: 0, signal: session.abort.signal }, () => {
        cleanup();
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('Cannot resolve the local tunnel port.')); return; }
        resolve(address.port);
      });
    });
  }

  private connectionLost(session: Session, error: Error): void {
    if (session.closing || this.session !== session) return;
    this.session = undefined;
    void this.closeSession(session);
    this.options.log('SSH connection closed; the remote instance is unchanged.');
    this.options.onClose(error);
  }

  private closeSession(session: Session): Promise<void> {
    if (session.closed) return session.closed;
    session.closing = true;
    session.removeAbort?.();
    session.abort.abort();
    for (const socket of session.sockets) socket.destroy();
    for (const channel of session.channels) channel.destroy();
    session.sockets.clear();
    session.channels.clear();
    session.client.destroy();
    session.closed = new Promise(resolve => {
      if (!session.server?.listening) { resolve(); return; }
      session.server.close(() => resolve());
    });
    return session.closed;
  }
}
