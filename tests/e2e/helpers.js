/*
 * ============================================================================
 *  tests/e2e/helpers.js — Shared Playwright setup for E2E specs
 * ============================================================================
 *
 * Every E2E spec in this folder calls `installStubs(page)` before
 * navigating to the app. That helper does three important things:
 *
 *   1. Intercepts every Firebase module URL and serves the stub bundle
 *      from fixtures/firebase-stubs.js. Playwright's `page.route` matches
 *      the URL glob before the browser's network layer ever sees the
 *      request — so we never actually hit Google's servers during tests.
 *   2. Intercepts the Gemini API endpoint. The default handler returns a
 *      controlled error so we can assert the UI surfaces it correctly.
 *      Individual tests override the handler for their own scenarios.
 *   3. Pre-seeds localStorage with a fake Gemini API key so the key-entry
 *      UI doesn't show up unless the test specifically wants to test
 *      that flow.
 *
 * Keeping this shared makes every spec short and focused — tests describe
 * ONE scenario each, not all the boilerplate.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read the stub bundle ONCE at startup. Playwright sends the same bytes
// to the browser regardless of which Firebase module was requested, and
// that's fine — the bundle exports the union of all three modules.
const STUB_SOURCE = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'firebase-stubs.js'),
    'utf8'
);

export const installStubs = async (page, options = {}) => {
    const {
        apiKey = 'fake-test-key',
        // geminiHandler receives the Playwright Route and should call
        // route.fulfill / route.abort. Default is "billing error" — the
        // scenario from manual Test 2. Override per-test as needed.
        geminiHandler = defaultBillingError,
    } = options;

    // Route every firebasejs CDN URL to our stub bundle. Order matters —
    // Playwright applies routes in registration order, and we want this
    // catch-all to be in place before the page starts loading imports.
    await page.route('**/firebasejs/**/*.js', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/javascript',
            body: STUB_SOURCE,
        });
    });

    // Gemini API. The glob deliberately catches both the v1beta path and
    // any alpha/alpha-paid variants Google might redirect to.
    await page.route('**/generativelanguage.googleapis.com/**', geminiHandler);

    // Seed the API key so we skip the "please enter your key" prompt
    // unless the test explicitly clears it.
    await page.addInitScript((k) => {
        window.localStorage.setItem('geminiApiKey', k);
    }, apiKey);
};

// ---------- canned Gemini responses ----------

// Matches the exact error Google returned during manual Test 2.
export const defaultBillingError = async (route) => {
    await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
            error: {
                code: 403,
                status: 'PERMISSION_DENIED',
                message: 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.',
            },
        }),
    });
};

// Returns a fully-formed applicant payload so the "happy path" tests can
// assert that a file upload results in a new row appearing in the table.
export const geminiHappyPath = (payload) => async (route) => {
    const body = {
        candidates: [{
            content: {
                parts: [{
                    text: JSON.stringify(payload),
                }],
            },
        }],
    };
    await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
    });
};
