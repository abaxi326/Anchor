import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { inferenceEndpoint, inferenceFetch } from '../src/agent/inference';

test('worker accepts direct HTTP and HTTPS endpoints with proxy path prefixes', () => {
  assert.equal(inferenceEndpoint('http://203.0.113.10:18000/v1').href, 'http://203.0.113.10:18000/v1');
  assert.equal(inferenceEndpoint('https://gpu.example.test/proxy/8000/v1/').pathname, '/proxy/8000/v1/');
  for (const invalid of ['ftp://gpu.example.test/v1', 'file:///v1', 'http://user:secret@gpu.example.test/v1',
    'http://gpu.example.test/v1?token=secret', 'https://gpu.example.test/v1#fragment', 'not-a-url']) {
    assert.throws(() => inferenceEndpoint(invalid), /Invalid inference endpoint/);
  }
});

test('inference redirects cannot forward credentials or request bodies to another origin', async () => {
  let destinationHits = 0;
  const destination = createServer((_request, response) => { destinationHits++; response.end('unexpected'); });
  await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
  const destinationAddress = destination.address();
  assert(destinationAddress && typeof destinationAddress === 'object');
  const destinationUrl = `http://127.0.0.1:${destinationAddress.port}/capture`;
  let sourceAuthorization: string | undefined;
  let sourceBody = '';
  const source = createServer(async (request, response) => {
    sourceAuthorization = request.headers.authorization;
    for await (const part of request) sourceBody += part;
    response.writeHead(307, { Location: destinationUrl }).end();
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const sourceAddress = source.address();
  assert(sourceAddress && typeof sourceAddress === 'object');
  const endpoint = inferenceEndpoint(`http://127.0.0.1:${sourceAddress.port}/v1`);
  try {
    const fetch = inferenceFetch(endpoint, true);
    await assert.rejects(fetch(`${endpoint.href}/chat/completions`, {
      method: 'POST', headers: { Authorization: 'Bearer private-key' }, body: 'private-workspace-context',
    }), /fetch failed/);
    assert.equal(sourceAuthorization, 'Bearer private-key');
    assert.equal(sourceBody, 'private-workspace-context');
    assert.equal(destinationHits, 0);
    await assert.rejects(fetch(destinationUrl), /configured API origin/);
    assert.equal(destinationHits, 0);
  } finally {
    for (const server of [source, destination]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
