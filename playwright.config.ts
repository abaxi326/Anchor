import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'webview.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 20_000,
  reporter: 'list',
  use: {
    viewport: { width: 340, height: 900 },
    headless: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (process.platform === 'win32'
        ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
        : undefined),
    },
    screenshot: 'only-on-failure',
  },
});
