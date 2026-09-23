import { build, context } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
const targets = [
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', platform: 'node', format: 'cjs', external: ['vscode', 'ssh2'] },
  { entryPoints: ['src/agent/worker.ts'], outfile: 'dist/worker.mjs', platform: 'node', format: 'esm', packages: 'external' },
  { entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife' },
];
await copyFile('src/webview/style.css', 'dist/webview.css');
for (const target of targets) {
  const options = { ...target, bundle: true, sourcemap: true, target: 'es2022', logLevel: 'info' };
  if (process.argv.includes('--watch')) { const ctx = await context(options); await ctx.watch(); }
  else await build(options);
}
