# Tests

This folder contains everything that helps you verify the app works without
having to click through it manually. There are two layers:

```
tests/
├── unit/        # Node built-in test runner. Pure logic. ~milliseconds.
│   ├── scoring.test.mjs   → covers src/scoring.js
│   └── errors.test.mjs    → covers src/errors.js
└── e2e/         # Playwright. Real browser, stubbed network. Seconds.
    ├── smoke.spec.js          → app boots + manual add works
    ├── ai-errors.spec.js      → manual Test 1 + Test 2 scenarios
    ├── helpers.js             → shared stubs/route helpers
    └── fixtures/
        └── firebase-stubs.js  → in-browser Firebase stand-in
```

## How to run

Unit tests need nothing but Node 20+:

```bash
npm run test:unit
```

End-to-end tests need Playwright and its browser binary:

```bash
npm install
npx playwright install chromium
npm run test:e2e
```

`npm test` runs both.

## Why two layers?

**Unit tests** live in `tests/unit/` and cover modules in `src/`. They're fast
(under a second), have no browser, no network, and no dependencies beyond
Node. Use them to pin the behavior of pure functions — scoring formulas,
error classification, and any future helpers. Every time you find a scoring
edge case in the wild, add a test here so you only ever find it once.

**E2E tests** live in `tests/e2e/` and drive the real `index.html` in
Chromium. They exist to catch the class of bug you *can't* hit with unit
tests: Firebase initialization ordering, modal flow, table rendering,
event delegation, toast text. They're slower (seconds) and flakier, so we
only add one when the unit layer genuinely can't cover the case.

Both the Firebase CDN and the Gemini API are intercepted by the test
harness (see `tests/e2e/helpers.js`). No real network calls leave the test
machine. That means:

- No secrets in CI.
- No billable Firestore or Gemini usage.
- Tests are deterministic — the canned responses are defined in
  `helpers.js` and each spec picks the one it wants.

## The manual-test ↔ automated-test mapping

| Manual test (2026-04-23)        | Automated replacement                         |
|---------------------------------|-----------------------------------------------|
| Test 1 — batch DOCX drop fails  | `ai-errors.spec.js` → "batch-drop: all-files-same-reason..." |
| Test 2 — billing error shown    | `ai-errors.spec.js` → "single-upload: billing error..."       |
| Test 3 — manual add works       | `smoke.spec.js` → "manual add flow..."         |

When you run into a new manual bug, add a row to that table and write the
spec that would have caught it. That way the manual log in the README
stays the ground truth for what the suite covers.

## Writing a new E2E test

Three patterns cover almost everything:

1. **Static check** — "the app renders X when I do Y". Just drive the
   UI and assert with `expect(locator).toBeVisible()` etc.
2. **Mocked Gemini** — call `installStubs(page, { geminiHandler: ... })`
   with the handler you want. Use `geminiHappyPath(payload)` from
   `helpers.js` if you want it to succeed, or write an inline
   `route.fulfill({ status: 500, ... })` for a custom error.
3. **Test hooks** — if the interaction is hard to drive through real
   drag-and-drop, use `window.__testHooks` (defined in `index.html`) to
   seed state and invoke the internal function directly. Keep these
   narrow — if a test needs more than a seed and a call, add a real DOM
   path instead.

## What isn't tested yet

- XSS — we know applicant names, emails, notes, tier labels, and AI
  responses are rendered with `innerHTML`. Until the templating is
  rewritten, treat any tests around this as a false sense of security.
- Firestore security rules — the stubs bypass rules entirely. If we
  ever tighten rules, add an emulator-backed job.
- PDF.js / mammoth parsing — we never actually parse a real file in
  tests. If those libraries change their API, we'll find out in
  production. A fixture-based parsing test would live in `tests/unit/`
  with a pair of small sample files.
