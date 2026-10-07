import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e', fullyParallel: false, workers: 1, timeout: 100_000,
  use: { baseURL: 'http://127.0.0.1:5174', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run dev', url: 'http://127.0.0.1:5174', reuseExistingServer: false,
    env: { PORT: '5174', LOCAL_TABLE_SUFFIX: 'e2e', LOCAL_PRICE_FIXTURE: 'up', LOCAL_STATIC: 'true' }, timeout: 120_000,
  },
});
