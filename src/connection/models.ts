import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export function connectionCancelled(): Error {
  const error = new Error('Connection cancelled.');
  error.name = 'AbortError';
  return error;
}

/** Bounded model discovery. Node's HTTP clients never follow redirects. */
async function readModels(url: string, apiKey: string | undefined, signal: AbortSignal): Promise<string[]> {
  if (signal.aborted) throw connectionCancelled();
  if (apiKey && /[\r\n\x00]/.test(apiKey)) throw new Error('The API key contains invalid characters.');
  return new Promise((resolve, reject) => {
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
    const request = new URL(url).protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(url, { headers, signal, agent: false }, res => {
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        const message = status >= 300 && status < 400
          ? 'The model URL redirects elsewhere. Enter the final vLLM URL directly; credentials are never forwarded to redirects.'
          : status === 401 || status === 403
            ? 'The model server rejected the API key. Enter its API key if authentication is enabled.'
            : status === 404
              ? 'The model API was not found. Use the exposed vLLM HTTP port or proxy URL, not the SSH port or instance dashboard.'
              : `Model readiness check failed (HTTP ${status || 'unknown'}). Check that vLLM is running.`;
        reject(new Error(message));
        req.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          reject(new Error('The model server returned an oversized model list.'));
          req.destroy();
        } else chunks.push(chunk);
      });
      res.on('error', () => reject(signal.aborted ? connectionCancelled() : new Error('The model readiness response was interrupted.')));
      res.on('end', () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) throw new Error();
          const ids = body.data.map((entry: unknown) => {
            if (!entry || typeof entry !== 'object' || !('id' in entry)
              || typeof entry.id !== 'string' || !entry.id.trim() || /[\x00-\x1f\x7f]/.test(entry.id)) throw new Error();
            return entry.id;
          });
          resolve([...new Set(ids)]);
        } catch { reject(new Error('The URL did not return an OpenAI-compatible model list. Use the vLLM API URL, not a web page or SSH endpoint.')); }
      });
    });
    const timer = setTimeout(() => {
      reject(new Error('The model server did not answer within 15 seconds. Check the vLLM HTTP port, proxy URL, and startup status.'));
      req.destroy();
    }, 15000);
    req.once('close', () => clearTimeout(timer));
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (signal.aborted) { reject(connectionCancelled()); return; }
      reject(new Error(error.code?.startsWith('HPE_')
        ? 'This port did not speak HTTP. If this is the Vast SSH port, replace it with the exposed vLLM HTTP port or proxy URL.'
        : 'Cannot reach the vLLM API. Check the exposed HTTP port or proxy URL, HTTPS certificate, and that the server is running.'));
    });
    req.end();
  });
}

export async function discoverModel(baseUrl: string, requested: string, apiKey: string | undefined, signal: AbortSignal): Promise<string> {
  const models = await readModels(`${baseUrl}/models`, apiKey, signal);
  if (signal.aborted) throw connectionCancelled();
  if (requested) {
    if (!models.includes(requested)) throw new Error('The configured model was not advertised by the server. Check its served model name.');
    return requested;
  }
  if (models.length !== 1) {
    throw new Error(models.length
      ? 'The server advertises multiple models. Enter the exact model name in connection settings.'
      : 'The server did not advertise a model. Start the inference server before connecting.');
  }
  return models[0];
}
