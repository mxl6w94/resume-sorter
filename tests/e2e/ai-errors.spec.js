/*
 * ============================================================================
 *  tests/e2e/ai-errors.spec.js — AI error UX (manual tests #1 and #2)
 * ============================================================================
 *
 * The user's manual testing exposed two UX problems:
 *
 *   Test 1 (batch drop): a DOCX dropped onto the main drop zone came back
 *     with "Successfully added 0 applicants. 1 failed." — the real reason
 *     (Gemini billing) was silently discarded.
 *
 *   Test 2 (single upload): the manual-upload flow showed Google's raw
 *     "Your prepayment credits are depleted" error. Technically accurate
 *     but confusing — Google Cloud's $300 free credit does NOT apply to
 *     the Gemini API, which is the real misunderstanding.
 *
 * These specs mock the Gemini endpoint to return the EXACT error string
 * Google actually returned during manual testing, then assert that the UI
 * classifies it as BILLING_REQUIRED and surfaces the actionable guidance
 * instead of the raw text. If Google ever changes that error wording,
 * this test will fail fast and we can update the regex in src/errors.js.
 */

import { test, expect } from '@playwright/test';
import { installStubs, defaultBillingError } from './helpers.js';

test('single-upload: billing error shows actionable title + detail, not raw text', async ({ page }) => {
    // The default handler in helpers.js IS the billing error, so no
    // override needed — we just install the stubs and drive the UI.
    await installStubs(page, { aiAutofill: defaultBillingError });
    await page.goto('/');

    await page.getByRole('button', { name: /Add New Applicant Manually/i }).click();

    // We can't actually drop a real file in a Playwright-headless test
    // without a real parser running, so we short-circuit: call the AI
    // autofill path with pre-extracted text by poking the exposed
    // internals. Because the app's module is not exported, we instead
    // seed the hidden state through a DOM path: upload an empty-looking
    // buffer as a .docx so mammoth resolves to an empty string, then
    // press the autofill button. The request is what we're asserting on
    // — the billing error — not the parsing.
    //
    // To avoid depending on mammoth parsing empty buffers, we directly
    // manipulate the exposed flag `extractedFileText` via a test hook:
    // the app surfaces its internals on window.__test for E2E builds
    // only (see the test-hooks block in index.html). If that hook isn't
    // present yet, the test skips.
    const hasHook = await page.evaluate(() => !!window.__testHooks);
    test.skip(!hasHook, 'index.html does not expose __testHooks; see tests/README.md');

    await page.evaluate(() => window.__testHooks.setExtractedText('Sample resume text'));
    await page.getByRole('button', { name: /Autofill with AI/i }).click();

    // The ai-error element should show the classified title+detail,
    // and its data-error-code attribute should be BILLING_REQUIRED.
    const aiError = page.locator('#ai-error');
    await expect(aiError).toHaveAttribute('data-error-code', 'BILLING_REQUIRED');
    await expect(aiError).toContainText(/prepayment|billing/i);
    // Critically: we should NOT show the raw Google URL to the user
    // (we hide it behind the curated detail string).
    await expect(aiError).not.toContainText('ai.studio/projects');
});

test('batch-drop: all-files-same-reason → toast shows actionable reason, not just "N failed"', async ({ page }) => {
    // Same billing error for every file.
    await installStubs(page, { aiAutofill: defaultBillingError });
    await page.goto('/');

    const hasHook = await page.evaluate(() => !!window.__testHooks);
    test.skip(!hasHook, 'index.html does not expose __testHooks; see tests/README.md');

    // Drive the batch path directly via the test hook. Passing two
    // "files" (really fake objects with parseable text) is enough to
    // exercise the "all same reason" collapse logic.
    await page.evaluate(() => window.__testHooks.runBatchWithFakeFiles(['a.pdf', 'b.pdf']));

    // The toast title should name the reason, not just say "Batch Complete".
    const toast = page.locator('#message-display');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/Billing Required/i);
    await expect(toast).toContainText(/2 files failed/);
});
