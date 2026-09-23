/** Validate again at the worker boundary; only the selected endpoint receives code. */
export function inferenceEndpoint(baseUrl: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); }
  catch { throw new Error('Invalid inference endpoint. Use an HTTP or HTTPS API URL.'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Invalid inference endpoint. Use HTTP or HTTPS without credentials, query parameters, or a fragment.');
  }
  return endpoint;
}

/** Keep requests and their bodies on the configured origin; never follow redirects. */
export function inferenceFetch(endpoint: URL, hasApiKey: boolean): typeof globalThis.fetch {
  const fetch = globalThis.fetch;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== endpoint.origin || url.username || url.password) {
      throw new Error('Inference request left the configured API origin.');
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    // Pi requires a credential to activate a custom provider. Its placeholder is
    // internal only: an unauthenticated vLLM endpoint receives no bearer header.
    if (!hasApiKey) headers.delete('authorization');
    return fetch(input, { ...init, headers, redirect: 'error' });
  };
}
