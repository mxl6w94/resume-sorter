/*
 * ============================================================================
 *  functions/index.js — Cloud Function proxy for the Gemini API
 * ============================================================================
 *
 * PURPOSE
 * -------
 * This file exposes ONE HTTPS-callable function, `aiAutofill`, which the
 * browser calls in place of its old direct fetch to `generativelanguage.
 * googleapis.com`. The point of this indirection is simple: the Gemini API
 * key lives in Google Secret Manager, is read by this function at runtime,
 * and is never sent to the browser. A user who opens DevTools sees only
 * the call to *our* function — not the key.
 *
 * WHY A CLOUD FUNCTION AND NOT, SAY, A STATIC /api ROUTE
 * ------------------------------------------------------
 * GitHub Pages (where the frontend is hosted) has no server side. Firebase
 * Functions is the smallest amount of "real backend" we can add without
 * giving up the static-hosting model. It also integrates natively with
 * Firebase Auth, so verifying the caller is one line (see `auth` check
 * below), and it integrates with Secret Manager so the key never appears
 * in source or config files.
 *
 * THE REQUEST/RESPONSE CONTRACT
 * -----------------------------
 *   Input  (sent by the browser via httpsCallable):
 *     {
 *       resumeText: string,      // raw extracted text from the PDF/DOCX
 *       criteria:   Criterion[], // the user's current ranking criteria
 *                                // (same shape stored in Firestore)
 *     }
 *   Output:
 *     {
 *       name: string,
 *       email: string,
 *       notes: string,
 *       // plus one key per AI-powered criterion, matching criterion.id
 *     }
 *
 * ERROR MODEL
 * -----------
 * We rethrow Gemini errors as Firebase `HttpsError`, preserving the original
 * message. On the browser, `httpsCallable` rejects with an Error whose
 * `.message` contains that text, which lets `src/errors.js classifyAiError`
 * still detect "prepayment", "quota exceeded", etc. by keyword — so the
 * same UX classification code works for both the old direct-call shape and
 * this new proxied shape.
 *
 * RATE LIMITING
 * -------------
 * A per-user quota is enforced via a counter document in Firestore:
 *   /usage/{uid}  { hourlyCount: number, hourlyResetAt: Timestamp }
 * The quota is deliberately conservative (30 autofills per hour per user)
 * because the whole point of moving the key server-side is to cap the blast
 * radius of abuse. If you need more, bump MAX_PER_HOUR below, but first ask
 * yourself whether a legitimate user needs more than 30 autofills an hour.
 *
 * SECRET MANAGEMENT
 * -----------------
 * The Gemini API key is stored in Google Secret Manager under the secret
 * name GEMINI_API_KEY. Set it once with:
 *
 *   firebase functions:secrets:set GEMINI_API_KEY
 *
 * The CLI will prompt you to paste the key (it doesn't echo). The value is
 * stored in Secret Manager, and this function declares a binding via the
 * `secrets` option below — at runtime the key is available as
 * process.env.GEMINI_API_KEY. If you rotate the key, re-run the command
 * above and redeploy: no code change needed.
 *
 * DEPLOY
 * ------
 *   firebase deploy --only functions
 *
 * REGION
 * ------
 * We pin the region so the URL is stable and the latency is predictable.
 * us-central1 is the cheapest and most common for North American projects.
 * If your users are elsewhere, change this — the frontend `getFunctions`
 * call must match, or the browser hits the default region and 404s.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

// The Secret Manager binding. Functions won't deploy without this secret
// existing; they also won't run until it's been set with the CLI.
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

initializeApp();
const db = getFirestore();

// Per-user rate limit. Keep conservative — the whole point of moving the
// key server-side is to cap abuse.
const MAX_PER_HOUR = 30;

// The Gemini model we proxy to. Keeping it configurable here — not on the
// client — means swapping models never requires a frontend redeploy.
//
// HISTORY: started on 'gemini-2.0-flash' (what the original client code
// used). Google deprecated that model for new API keys in April 2026 —
// existing keys kept working but keys issued after the cutover got a 404
// with "This model is no longer available to new users." Since this
// project's key was issued around that time, we bumped to 2.5-flash,
// which is the current low-latency tier and supports the same JSON
// schema / responseMimeType features we rely on. If Google deprecates
// this one too, update the string and redeploy — no frontend change.
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * Build the prompt and JSON schema the same way the old client-side code
 * did. Kept as a plain function (not a method) so it's trivially unit
 * testable if we add a functions-side test suite later.
 */
function buildGeminiPayload(resumeText, criteria) {
    const aiCriteria = (criteria || []).filter(c => c.isAiPowered);
    const schemaProperties = {
        name:  { type: 'STRING' },
        email: { type: 'STRING' },
        notes: { type: 'STRING' },
    };
    const requiredFields = ['name', 'email', 'notes'];
    const dynamicPrompts = [];

    for (const c of aiCriteria) {
        switch (c.type) {
            case 'numeric':
                schemaProperties[c.id] = { type: 'NUMBER' };
                dynamicPrompts.push(`"${c.id}": "A number from ${c.min || 0} to ${c.max || 10} based on: ${c.aiPrompt}"`);
                requiredFields.push(c.id);
                break;
            case 'yes_no':
                schemaProperties[c.id] = { type: 'STRING', enum: ['Yes', 'No'] };
                dynamicPrompts.push(`"${c.id}": "Answer 'Yes' or 'No' based on: ${c.aiPrompt}"`);
                requiredFields.push(c.id);
                break;
            case 'tiered': {
                const levels = (c.tiers || []).map(t => t.level).filter(Boolean);
                if (levels.length === 0) break;
                schemaProperties[c.id] = { type: 'STRING', enum: levels };
                dynamicPrompts.push(`"${c.id}": "Choose one of [${levels.join(', ')}] based on: ${c.aiPrompt}"`);
                requiredFields.push(c.id);
                break;
            }
        }
    }

    const dynamicPromptStr = dynamicPrompts.length ? ',\n' + dynamicPrompts.join(',\n') : '';
    const prompt = `You are an expert HR assistant. Based on the following resume text, extract the candidate's information. Format the output as a JSON object. Resume Text: --- ${resumeText} --- Desired JSON Output Structure: { "name": "Candidate's full name", "email": "Candidate's email address", "notes": "A brief 2-3 sentence summary of key qualifications."${dynamicPromptStr} }`;

    return {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: { type: 'OBJECT', properties: schemaProperties, required: requiredFields },
        },
    };
}

/**
 * Check-and-increment the per-user hourly quota. Returns silently if the
 * user is under their cap; throws an HttpsError otherwise. Uses a Firestore
 * transaction so concurrent requests from the same user can't both squeak
 * under a near-full quota.
 */
async function enforceRateLimit(uid) {
    const ref = db.doc(`usage/${uid}`);
    const nowMs = Date.now();

    await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists ? snap.data() : {};
        const resetAtMs = data.hourlyResetAt?.toMillis?.() || 0;
        let count = data.hourlyCount || 0;

        // If the hour window expired, reset.
        if (nowMs > resetAtMs) {
            count = 0;
        }

        if (count >= MAX_PER_HOUR) {
            throw new HttpsError(
                'resource-exhausted',
                `Rate limit: max ${MAX_PER_HOUR} AI autofills per hour per user. Try again later.`
            );
        }

        tx.set(ref, {
            hourlyCount: count + 1,
            // Only move the window forward when we reset. Otherwise leave
            // it where it was, so the user doesn't get a fresh hour every
            // single request.
            hourlyResetAt: nowMs > resetAtMs
                ? Timestamp.fromMillis(nowMs + 60 * 60 * 1000)
                : data.hourlyResetAt,
            lastCallAt: FieldValue.serverTimestamp(),
        }, { merge: true });
    });
}

/**
 * The public HTTPS-callable. Firebase handles Auth token verification
 * automatically when you read `request.auth`; if the caller isn't signed
 * in, `request.auth` is null and we throw 'unauthenticated'.
 */
export const aiAutofill = onCall(
    {
        secrets: [GEMINI_API_KEY],
        region: 'us-central1',
        // cors: true is the default for onCall v2, but being explicit saves
        // the next person 10 minutes of confusion if it ever seems broken.
        cors: true,
        // Small timeout — Gemini usually returns in <5s. If it's taking 60s
        // something is wrong and we'd rather fail fast.
        timeoutSeconds: 60,
        memory: '256MiB',
    },
    async (request) => {
        // --- 1. Require authentication ----------------------------------
        if (!request.auth) {
            throw new HttpsError('unauthenticated', 'You must be signed in to use AI autofill.');
        }
        const uid = request.auth.uid;

        // --- 2. Validate input ------------------------------------------
        const { resumeText, criteria } = request.data || {};
        if (typeof resumeText !== 'string' || resumeText.trim().length === 0) {
            throw new HttpsError('invalid-argument', 'resumeText is required.');
        }
        if (resumeText.length > 50_000) {
            // Guardrail: a 50k-char resume is already enormous (~8k words).
            // If we see more, it's more likely abuse than a real resume.
            throw new HttpsError('invalid-argument', 'resumeText is too long (max 50000 characters).');
        }
        if (!Array.isArray(criteria)) {
            throw new HttpsError('invalid-argument', 'criteria must be an array.');
        }

        // --- 3. Per-user rate limit -------------------------------------
        await enforceRateLimit(uid);

        // --- 4. Call Gemini ---------------------------------------------
        const payload = buildGeminiPayload(resumeText, criteria);
        const url = `${GEMINI_URL}?key=${encodeURIComponent(GEMINI_API_KEY.value())}`;

        // Retry on 429 with exponential backoff, same policy the client
        // used before. Cap at 4 attempts so we don't hold the function open
        // past its 60s timeout.
        let response;
        for (let i = 0; i < 4; i++) {
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (response.status !== 429) break;
            await new Promise(r => setTimeout(r, (2 ** i) * 1000));
        }

        if (!response.ok) {
            let message = `Gemini API request failed with status ${response.status}`;
            try {
                const errBody = await response.json();
                if (errBody?.error?.message) message = errBody.error.message;
            } catch { /* ignore; we'll use the default message */ }

            // Map Gemini's HTTP status onto the closest HttpsError code so
            // the browser gets something sensible in .code (for logging)
            // while .message still carries Gemini's text (for our keyword
            // classifier in src/errors.js).
            const code =
                response.status === 403 ? 'permission-denied'   :
                response.status === 404 ? 'not-found'           :
                response.status === 429 ? 'resource-exhausted'  :
                response.status >= 500  ? 'internal'            :
                                          'failed-precondition';
            throw new HttpsError(code, message);
        }

        // --- 5. Parse and return ----------------------------------------
        const result = await response.json();
        const aiJsonText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!aiJsonText) {
            throw new HttpsError('internal', 'AI returned an unexpected data structure.');
        }
        try {
            return JSON.parse(aiJsonText);
        } catch {
            throw new HttpsError('internal', 'AI returned data that was not valid JSON.');
        }
    }
);
