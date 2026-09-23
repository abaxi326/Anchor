// Exercise the entrypoint without Docker, a GPU, network access, or model downloads.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bash = process.env.BASH_PATH ?? (process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash');
const script = path.join(root, 'scripts', 'start-vllm.sh');
const posixPath = (value) => process.platform === 'win32'
  ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
  : value;
function run(args, env = {}) {
  const result = spawnSync(bash, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
run(['-n', script]);
const artifacts = path.join(root, '.test-artifacts');
await mkdir(artifacts, { recursive: true });
const fixture = await mkdtemp(path.join(artifacts, 'worker-launch-'));
try {
  const fake = path.join(fixture, 'vllm');
  await writeFile(fake, '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s\\0" "$@" > "$ANCHOR_CHECK_ARGS"\nprintf "%s" "$HF_HOME" > "$ANCHOR_CHECK_CACHE"\n');
  await chmod(fake, 0o755);
  for (const override of [false, true]) {
    const argsFile = path.join(fixture, `args-${override}`);
    const cacheFile = path.join(fixture, `cache-${override}`);
    const cacheDir = path.join(fixture, `cache directory ${override}`);
    const env = {
      ANCHOR_CHECK_ARGS: posixPath(argsFile), ANCHOR_CHECK_CACHE: posixPath(cacheFile), HF_HOME: posixPath(cacheDir),
      OPEN_ANCHOR_MODEL: override ? 'example/model with spaces' : '',
      OPEN_ANCHOR_CONTEXT: override ? '16384' : '', OPEN_ANCHOR_HOST: override ? '127.0.0.1' : '',
      OPEN_ANCHOR_PORT: override ? '9000' : '',
    };
    run(['-c', 'export PATH="$1:$PATH"; shift; exec bash "$@"', 'worker-check', posixPath(fixture), posixPath(script),
      '--generation-config', 'config with spaces.json'], env);
    const args = (await readFile(argsFile, 'utf8')).split('\0').slice(0, -1);
    const value = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(args[0], 'serve');
    assert.equal(args[1], override ? 'example/model with spaces' : 'Inferact/Qwen3.8-27B-NVFP4');
    assert.equal(value('--served-model-name'), 'open-anchor');
    assert.equal(value('--host'), override ? '127.0.0.1' : '0.0.0.0');
    assert.equal(value('--port'), override ? '9000' : '8000');
    assert.equal(value('--max-model-len'), override ? '16384' : '32768');
    assert.equal(value('--tool-call-parser'), 'qwen3_xml');
    assert.equal(value('--reasoning-parser'), 'qwen3');
    assert(args.includes('--enforce-eager'));
    assert(args.includes('--enable-auto-tool-choice'));
    assert.deepEqual(args.slice(-2), ['--generation-config', 'config with spaces.json']);
    assert.equal(await readFile(cacheFile, 'utf8'), posixPath(cacheDir));
    await access(cacheDir);
  }
  console.log('Worker launch check passed: Bash syntax, defaults, environment overrides, cache creation, and argument forwarding. No GPU or image download used.');
} finally {
  await rm(fixture, { recursive: true, force: true });
}
