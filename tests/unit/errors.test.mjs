/*
 * ============================================================================
 *  tests/unit/errors.test.mjs — Unit tests for src/errors.js
 * ============================================================================
 *
 * These tests pin the error-classification behavior. Google rewrites the
 * exact text of their API errors every few months, so the point of this
 * file is to make sure the phrases we know about today STILL map to the
 * right `ErrorCode` tomorrow. If one of these tests breaks because Google
 * changed the wording, update the regex in src/errors.js — don't just
 * relax the test.
 *
 * The most important case, from the user's manual Test 2, is covered by
 * the first test: the prepayment-credits message must classify as
 * BILLING_REQUIRED so the UI can show the "your $300 free credit does not
 * apply to Gemini" guidance.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAiError, describeAiError, ErrorCode } from '../../src/errors.js';

test('classifies the exact prepayment error from manual Test 2', () => {
    const msg = 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.';
    assert.equal(classifyAiError(new Error(msg)), ErrorCode.BILLING_REQUIRED);
});

test('classifies common billing variants', () => {
    assert.equal(classifyAiError(new Error('Please enable billing for your project')), ErrorCode.BILLING_REQUIRED);
    assert.equal(classifyAiError(new Error('Payment Required')), ErrorCode.BILLING_REQUIRED);
});

test('classifies quota / rate-limit errors', () => {
    assert.equal(classifyAiError(new Error('Quota exceeded for quota metric ...')), ErrorCode.QUOTA_EXCEEDED);
    assert.equal(classifyAiError(new Error('Resource has been exhausted')), ErrorCode.QUOTA_EXCEEDED);
    assert.equal(classifyAiError({ error: { code: 429, message: 'Too Many Requests' } }), ErrorCode.QUOTA_EXCEEDED);
});

test('classifies invalid API key errors', () => {
    assert.equal(classifyAiError(new Error('API key not valid. Please pass a valid API key.')), ErrorCode.INVALID_KEY);
    assert.equal(classifyAiError(new Error('API_KEY_INVALID')), ErrorCode.INVALID_KEY);
});

test('classifies permission / 403 errors', () => {
    assert.equal(classifyAiError({ error: { code: 403, message: 'The caller does not have permission' } }), ErrorCode.PERMISSION);
    assert.equal(classifyAiError(new Error('PERMISSION_DENIED')), ErrorCode.PERMISSION);
});

test('classifies network / fetch TypeError', () => {
    const e = new TypeError('Failed to fetch');
    assert.equal(classifyAiError(e), ErrorCode.NETWORK);
});

test('classifies missing/retired model as MODEL_UNAVAILABLE', () => {
    assert.equal(classifyAiError({ error: { code: 404, message: 'Model not found' } }), ErrorCode.MODEL_UNAVAILABLE);
});

test('classifies BAD_RESPONSE for JSON-shaped failures we throw ourselves', () => {
    assert.equal(classifyAiError(new Error('AI returned an unexpected data structure.')), ErrorCode.BAD_RESPONSE);
});

test('unknown errors fall through to UNKNOWN (never throws)', () => {
    assert.equal(classifyAiError(new Error('the server caught fire')), ErrorCode.UNKNOWN);
    assert.equal(classifyAiError(null), ErrorCode.UNKNOWN);
    assert.equal(classifyAiError(undefined), ErrorCode.UNKNOWN);
    assert.equal(classifyAiError(42), ErrorCode.UNKNOWN);
});

test('describeAiError returns code + title + detail', () => {
    const d = describeAiError(new Error('Your prepayment credits are depleted.'));
    assert.equal(d.code, ErrorCode.BILLING_REQUIRED);
    assert.match(d.title, /Billing/);
    assert.match(d.detail, /prepayment|billing/i);
});
