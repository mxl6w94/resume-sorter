/*
 * ============================================================================
 *  src/errors.js — Gemini / AI error classification + actionable messages
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The original code showed the raw Gemini error text to the user, which is
 * confusing at best (examples we've actually seen in the wild):
 *
 *   - "Your prepayment credits are depleted. Please go to AI Studio at
 *     https://ai.studio/projects to manage your project and billing."
 *   - "API key not valid. Please pass a valid API key."
 *   - "Quota exceeded for quota metric..."
 *   - "Resource has been exhausted..."
 *
 * These are all real errors but they mean very different things to the user:
 * one needs a new key, one needs billing, one needs to wait. This module
 * centralises that mapping so the UI can show a short, actionable message
 * and our E2E tests can assert on a stable classification instead of
 * Google's free-form error text (which they change without notice).
 *
 * MANUAL TEST NOTES THIS MODULE ADDRESSES
 * ---------------------------------------
 * Prototype test log (2026-04-23):
 *   Test 1: batch drag-and-drop of a .docx reported "Successfully added 0
 *           applicants. 1 failed" — the true root cause (Gemini billing)
 *           was thrown away inside the batch loop. The fix has two parts:
 *           (a) `handleBatchUpload` should collect per-file errors and
 *               surface them, and (b) those errors should be classified by
 *               this module so the user knows *why* each file failed.
 *   Test 2: manual upload path surfaced the billing error verbatim. That
 *           message is technically accurate but doesn't tell the user that
 *           their $300 Google Cloud free credit DOES NOT apply to the
 *           Gemini API — AI Studio has its own billing. We rewrite the
 *           message here.
 *
 * This module is pure — no DOM, no network, no side effects — so it is
 * directly unit-testable from Node.
 */

/**
 * Stable error codes we emit. The UI and the E2E tests both match on these
 * rather than on raw error text. When you add a new one, add a test for it
 * in `tests/unit/errors.test.mjs`.
 */
export const ErrorCode = Object.freeze({
    BILLING_REQUIRED: 'BILLING_REQUIRED',   // Prepayment / billing not set up
    QUOTA_EXCEEDED:   'QUOTA_EXCEEDED',     // Hit rate or daily quota
    INVALID_KEY:      'INVALID_KEY',        // Key missing, malformed, revoked
    PERMISSION:       'PERMISSION',         // Key valid but lacks permission
    NETWORK:          'NETWORK',            // Browser couldn't reach the API
    MODEL_UNAVAILABLE:'MODEL_UNAVAILABLE',  // Model name wrong or retired
    BAD_RESPONSE:     'BAD_RESPONSE',       // 200 OK but JSON didn't parse
    UNKNOWN:          'UNKNOWN',            // Anything we don't recognize
});

/**
 * A curated set of suggestions keyed by ErrorCode. Kept short so they fit
 * inside the small red message banner at the top-right of the app. If you
 * need more detail, link to docs rather than expanding these strings.
 */
const Suggestions = {
    [ErrorCode.BILLING_REQUIRED]:
        "Your Gemini API key requires prepayment credits. Google Cloud's $300 free credit does NOT apply to Gemini — generate a key from aistudio.google.com without Cloud billing, or add prepaid credits in AI Studio.",
    [ErrorCode.QUOTA_EXCEEDED]:
        "Gemini rate limit or daily quota hit. Wait a minute and retry, or request a higher quota in AI Studio.",
    [ErrorCode.INVALID_KEY]:
        "The Gemini API key is missing, malformed, or revoked. Re-enter it in the key field.",
    [ErrorCode.PERMISSION]:
        "The API key is valid but does not have permission for this model. Check the key's restrictions in Google Cloud Console.",
    [ErrorCode.NETWORK]:
        "Couldn't reach the Gemini API. Check your internet connection and any ad-blocker/extension that might block generativelanguage.googleapis.com.",
    [ErrorCode.MODEL_UNAVAILABLE]:
        "The requested Gemini model is unavailable. Google may have retired it — try 'gemini-1.5-flash'.",
    [ErrorCode.BAD_RESPONSE]:
        "Gemini returned data that wasn't valid JSON. Usually transient — retry once.",
    [ErrorCode.UNKNOWN]:
        "An unexpected error occurred. Check the browser console for details.",
};

/**
 * Classify a Gemini error into one of the stable codes above.
 *
 * We try a sequence of signals, cheapest first. The caller may pass us any
 * of three shapes because we don't control where the error comes from:
 *
 *   1. A JS `Error` thrown from `fetch` (network failure) or from our own
 *      `throw new Error(errorData.error.message)` after a non-OK response.
 *   2. The parsed JSON body of a non-OK response — `{ error: { code, ...}}`.
 *   3. A plain string (legacy callers, test fixtures).
 *
 * The function never throws. If it can't classify, it returns UNKNOWN.
 */
export const classifyAiError = (err) => {
    // Normalize into { message, status } regardless of input shape. `status`
    // may be undefined; `message` is always a string (possibly "").
    let message = '';
    let status;

    if (err == null) {
        message = '';
    } else if (typeof err === 'string') {
        message = err;
    } else if (err instanceof Error) {
        message = err.message || '';
        // fetch() throws TypeError for network-level failures in every
        // modern browser. That's our cleanest signal for "offline".
        if (err.name === 'TypeError' && /fetch|network|failed to fetch/i.test(message)) {
            return ErrorCode.NETWORK;
        }
    } else if (typeof err === 'object') {
        // Shape: { error: { code, message, status } } — matches Gemini
        // and the broader Google API error envelope.
        const inner = err.error || err;
        message = inner.message || '';
        status = inner.code || inner.status;
    }

    const m = message.toLowerCase();

    // The order here matters. We check the most specific phrases first
    // because Google's error strings often contain multiple keywords.
    // "prepayment" is the telltale marker for the AI Studio billing case
    // the user hit during Test 2.
    if (/prepayment|billing|payment required|enable billing/.test(m)) {
        return ErrorCode.BILLING_REQUIRED;
    }
    if (/quota|rate limit|resource has been exhausted|too many requests/.test(m) || status === 429) {
        return ErrorCode.QUOTA_EXCEEDED;
    }
    if (/api key not valid|invalid api key|api_key_invalid|api key is missing/.test(m)) {
        return ErrorCode.INVALID_KEY;
    }
    if (/permission_denied|forbidden|does not have permission/.test(m) || status === 403) {
        return ErrorCode.PERMISSION;
    }
    if (/not found|model.*not found|unsupported.*model/.test(m) || status === 404) {
        return ErrorCode.MODEL_UNAVAILABLE;
    }
    if (/unexpected data structure|not valid json|unexpected token/.test(m)) {
        return ErrorCode.BAD_RESPONSE;
    }

    return ErrorCode.UNKNOWN;
};

/**
 * Produce a user-facing message pair `{ title, detail }` for an error.
 * Keeps the actual Gemini message in a DOM-safe console.debug at the call
 * site (not here — this module is pure) so support can recover it.
 */
export const describeAiError = (err) => {
    const code = classifyAiError(err);
    return {
        code,
        title: titleFor(code),
        detail: Suggestions[code],
    };
};

const titleFor = (code) => {
    switch (code) {
        case ErrorCode.BILLING_REQUIRED:  return 'Gemini Billing Required';
        case ErrorCode.QUOTA_EXCEEDED:    return 'Gemini Quota Exceeded';
        case ErrorCode.INVALID_KEY:       return 'Invalid API Key';
        case ErrorCode.PERMISSION:        return 'Permission Denied';
        case ErrorCode.NETWORK:           return 'Network Error';
        case ErrorCode.MODEL_UNAVAILABLE: return 'Model Unavailable';
        case ErrorCode.BAD_RESPONSE:      return 'Unexpected AI Response';
        default:                          return 'AI Error';
    }
};
