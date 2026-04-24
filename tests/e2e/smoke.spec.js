/*
 * ============================================================================
 *  tests/e2e/smoke.spec.js — "The app boots and I can add an applicant"
 * ============================================================================
 *
 * This is the baseline test that catches the biggest class of regressions:
 * something about the load sequence (CDN imports, Firebase init, auth) is
 * broken so the UI never reaches the logged-in state. If this test is
 * green, every more specific test below can assume the app is usable.
 *
 * It also covers manual Test 3 — "proceed to add the applicant manually
 * by hand" — so we never have to do that click sequence by hand again.
 *
 * How it works:
 *   - installStubs() intercepts Firebase and Gemini so no network calls
 *     leave the test machine.
 *   - The app sees the stub's immediate onAuthStateChanged callback and
 *     flips from login screen → app screen in a single microtask.
 *   - We fill the form, submit, and assert the new row is in the table.
 */

import { test, expect } from '@playwright/test';
import { installStubs } from './helpers.js';

test('loads past login and shows the empty ranked-applicants table', async ({ page }) => {
    await installStubs(page);
    await page.goto('/');

    // The header is only visible after auth resolves. If the login screen
    // is still showing, the stubs aren't being served correctly.
    await expect(page.getByRole('heading', { name: 'Applicant Ranking System' })).toBeVisible();
    await expect(page.getByText('No applicants found or matching search.')).toBeVisible();
});

test('manual add flow: fills the form and the row appears in the table', async ({ page }) => {
    await installStubs(page);
    await page.goto('/');

    await page.getByRole('button', { name: /Add New Applicant Manually/i }).click();
    await expect(page.getByRole('heading', { name: 'Add New Applicant' })).toBeVisible();

    await page.getByLabel('Full Name').fill('Ada Lovelace');
    await page.getByLabel('Email', { exact: true }).fill('ada@example.com');
    await page.getByLabel('Notes / Summary').fill('Invented the concept of a programmable machine.');

    // Submit and wait for the modal to disappear.
    await page.getByRole('button', { name: /Save Applicant/i }).click();
    await expect(page.getByRole('heading', { name: 'Add New Applicant' })).toBeHidden();

    // The new applicant should be in the table.
    await expect(page.getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible();
});
