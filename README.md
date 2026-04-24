# Resume Sorter

Live app: https://mxl6w94.github.io/resume-sorter/

A tiny, single-page applicant-ranking tool. The frontend is a static
`index.html` hosted on GitHub Pages. Firebase provides authentication
(Google sign-in) and per-user Firestore storage. A Cloud Function
proxies calls to Gemini so the API key stays server-side.

```
┌──────────────┐   httpsCallable    ┌─────────────────────┐   fetch    ┌────────┐
│  index.html  │ ─────────────────▶ │  aiAutofill          │ ─────────▶ │ Gemini │
│  (GH Pages)  │                    │  (Cloud Function)    │            │  API   │
└──────────────┘                    └─────────────────────┘            └────────┘
        │                                      │
        └──── Firestore (users/{uid}/**) ──────┘
```

## Architecture

- **Frontend** — `index.html` plus modules in `src/`. No build step.
  Loaded directly from GitHub Pages.
- **Firestore** — per-user collections at `users/{uid}/applicants`
  and `users/{uid}/criteria`. Rules in `firestore.rules` deny access
  to anything outside the caller's `uid`.
- **Cloud Function** — `functions/index.js` exposes one HTTPS-callable,
  `aiAutofill`, that reads the Gemini API key from Secret Manager and
  forwards resume text for structured extraction. Per-user rate limit
  of 30 calls/hour, enforced via a Firestore transaction on
  `usage/{uid}`.

## First-time setup (for a new maintainer)

You need the Firebase CLI logged into the `applicant-ranker` project.

1. Install dependencies:
   ```bash
   npm install
   cd functions && npm install && cd ..
   ```
2. Set the Gemini API key in Secret Manager (one-time; the CLI prompts
   for the value and never echoes it):
   ```bash
   firebase functions:secrets:set GEMINI_API_KEY
   ```
3. Deploy rules and the function:
   ```bash
   firebase deploy --only firestore:rules,functions
   ```

The frontend is auto-deployed by GitHub Pages from `main`.

## Development

Serve the page locally (the Firebase config in `index.html` points at
the production project, so this still works for everything except AI
autofill — which requires an authenticated call to the deployed
function):

```bash
npm run serve
```

### Tests

```bash
npm run test:unit        # pure-logic unit tests, no browser
npm run test:e2e         # Playwright, stubs Firebase + the callable
npm test                 # both
```

See `tests/README.md` for the full testing layout and philosophy.
Nothing in the test suite hits real Firebase or Gemini, so CI needs
no secrets.

### Rotating the Gemini key

If the key is leaked or rotated:

```bash
firebase functions:secrets:set GEMINI_API_KEY
firebase deploy --only functions
```

No frontend change is needed — the browser never sees the key.

## Why a Cloud Function?

An earlier version of this app shipped the Gemini API key in the
browser (prompting the user to paste it, or reading from localStorage).
That's a dead-end for a public deploy: anyone can pop DevTools, copy
the key, and burn through the quota. Moving the call to a function
means the key lives in Secret Manager, every caller is a signed-in
Firebase user, and we can enforce a per-user rate limit at the server
before we ever hit Gemini.
