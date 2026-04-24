/*
 * ============================================================================
 *  tests/e2e/helpers.js — Shared Playwright setup for E2E specs
 * ============================================================================
 *
 * Every E2E spec in this folder calls `installStubs(page)` before
 * navigating to the app. That helper does two important things:
 *
 *   1. Intercepts every Firebase module URL and serves the stub bundle
 *      from fixtures/firebase-stubs.js. Playwright's `page.route` matches
 *      the URL glob before the browser's network layer ever sees the
 *      request — so we never actually hit Google's servers during tests.
 *      The stub bundle includes a fake `httpsCallable` that dispatches
 *      to `window.__functionStubs[name]` — that's where each spec plugs
 *      in its scenario (happy path, billing error, quota, etc).
 *   2. Registers a default `aiAutofill` handler on window.__functionStubs
 *      that throws the billing-style error used in manual Test 2. Specs
 *      that want a different scenario override the handler before
 *      triggering the UI action.
 *
 * NOTE: we no longer intercept the Gemini REST endpoint. The browser
 * never calls Gemini directly anymore — it calls our Cloud Function,
 * and that call is mocked at the httpsCallable layer. We also no longer
 * seed an API key into localStorage; the client-side API-key UI was
 * removed when Gemini went server-side.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read the stub bundle ONCE at startup. Playwright sends the same bytes
// to the browser regardless of which Firebase module was requested, and
// that's fine — the bundle exports the union of all four modules
// (app, auth, firestore, functions).
const STUB_SOURCE = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'firebase-stubs.js'),
    'utf8'
);

export const installStubs = async (page, options = {}) => {
    const {
        // aiAutofill handler. Receives the payload { resumeText, criteria }
        // and must either return the AI JSON (happy path) or throw an
        // Error whose `.message` matches the Gemini-style text that
        // src/errors.js keys off of. Default is the billing error from
        // manual Test 2.
        aiAutofill = defaultBillingError,
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

    // Register the aiAutofill function stub on the page before any app
    // code runs. `addInitScript` injects this ahead of every navigation,
    // so the stub is in place by the time the app's module imports
    // resolve httpsCallable.
    await page.addInitScript((handlerSource) => {
        window.__functionStubs = window.__functionStubs || {};
        // The handler is serialized as a source string because Playwright
        // can't pass live closures across the bridge. We eval it in-page
        // to get a real function back.
        // eslint-disable-next-line no-eval
        window.__functionStubs.aiAutofill = eval('(' + handlerSource + ')');
    }, aiAutofill.toString());
};

// ---------- canned aiAutofill handlers ----------

// Matches the exact error message Gemini returned during manual Test 2.
// The Cloud Function re-throws Gemini's message verbatim inside an
// HttpsError, which on the browser surfaces as an Error whose .message
// contains the "prepayment" keyword our classifier looks for.
export const defaultBillingError = function defaultBillingError(_payload) {
    const err = new Error(
        'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.'
    );
    err.code = 'functions/permission-denied';
    throw err;
};

// Returns a fully-formed applicant payload so the "happy path" tests can
// assert that a file upload results in a new row appearing in the table.
// Usage: installStubs(page, { aiAutofill: geminiHappyPath({ name: ..., email: ... }) })
export const geminiHappyPath = (payload) => {
    // Serialize the payload into the handler source so Playwright can
    // ship it into the browser context without a live closure.
    const json = JSON.stringify(payload);
    // eslint-disable-next-line no-new-func
    return new Function('_payload', `return ${json};`);
};
