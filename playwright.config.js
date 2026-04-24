/*
 * ============================================================================
 *  playwright.config.js
 * ============================================================================
 *
 * Playwright needs to know (a) which folder the specs live in, (b) what
 * URL the tests `page.goto('/')` against, and (c) how to start a local
 * server so the browser has something to load. Because the app is a pure
 * static file, we use `http-server` — no build step, no Vite, no webpack.
 *
 * The `webServer` block below starts the server before tests run and
 * tears it down after. `reuseExistingServer: true` means if you already
 * have `npm run serve` running in another terminal, Playwright will use
 * it instead of starting a second one.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',
    // Only Chromium by default. Add firefox/webkit here if a test relies
    // on a browser-specific behavior — but prefer writing browser-agnostic
    // assertions so CI stays fast.
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    use: {
        baseURL: 'http://localhost:5173',
        trace: 'on-first-retry',
    },
    webServer: {
        command: 'npx http-server -p 5173 -c-1 --silent',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
    reporter: [['list']],
});
