/*
 * ============================================================================
 *  tests/unit/scoring.test.mjs — Unit tests for src/scoring.js
 * ============================================================================
 *
 * WHAT THIS FILE IS
 * -----------------
 * These are pure-logic unit tests for the scoring module. They use Node's
 * built-in `node:test` runner (Node 20+) so there are NO npm dependencies
 * to install — just `node --test tests/unit` and you're done. This is
 * deliberate: the project is a static HTML prototype and we don't want to
 * bloat the repo with jest/vitest/mocha unless we outgrow the built-in.
 *
 * HOW TO RUN
 * ----------
 *   node --test tests/unit
 *   # or:
 *   npm run test:unit
 *
 * WHAT THIS FILE TESTS
 * --------------------
 *   1. Happy paths — empty criteria, perfect applicants, mixed types.
 *   2. The normalization contract — a single criterion with weight 0.5
 *      and a perfect score STILL returns 100, not 50. Downstream UI relies
 *      on this.
 *   3. Documented quirks — negative numeric contributions, case-sensitive
 *      yes_no, empty/zero tiers. We assert the current behavior so if
 *      someone "fixes" one accidentally, the test will fail loudly and we
 *      can decide whether the change is intentional.
 *   4. The clamp/normalize helpers (`clampNumeric`, `normalizeYesNo`) that
 *      the UI layer should call at write time to prevent those quirks from
 *      ever reaching the DB.
 *   5. A simple throughput check — 1000 applicants × 10 criteria must
 *      score in under 200ms on a reasonable machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateScore, clampNumeric, normalizeYesNo } from '../../src/scoring.js';

// A small approximate-equality helper. JS floating point means 0.3 + 0.3
// + 0.4 isn't exactly 1.0, so exact === comparison would be flaky.
const approx = (a, b, eps = 0.001) => Math.abs(a - b) < eps;

test('calculateScore: empty criteria returns 0', () => {
    assert.equal(calculateScore({}, []), 0);
});

test('calculateScore: null criteria returns 0 (defensive)', () => {
    assert.equal(calculateScore({}, null), 0);
});

test('calculateScore: all-zero weights returns 0 (no divide-by-zero)', () => {
    const criteria = [
        { id: 'a', type: 'numeric', weight: 0, min: 0, max: 10 },
        { id: 'b', type: 'yes_no', weight: 0 },
    ];
    assert.equal(calculateScore({ a: 10, b: 'Yes' }, criteria), 0);
});

test('calculateScore: perfect applicant with weights summing to 1.0 → 100', () => {
    const criteria = [
        { id: 'a', type: 'numeric', weight: 0.5, min: 0, max: 10 },
        { id: 'b', type: 'yes_no', weight: 0.5 },
    ];
    assert.ok(approx(calculateScore({ a: 10, b: 'Yes' }, criteria), 100));
});

test('calculateScore: weights summing to 0.5 still normalize to 100 (documented)', () => {
    // This is the contract: whatever the weight sum is, we divide by it.
    // A change to this behavior would silently corrupt every user's rankings.
    const criteria = [{ id: 'a', type: 'numeric', weight: 0.5, min: 0, max: 10 }];
    assert.ok(approx(calculateScore({ a: 10 }, criteria), 100));
});

test('calculateScore: tiered criterion scores by matched level', () => {
    const criteria = [{
        id: 'exp', type: 'tiered', weight: 1.0,
        tiers: [{ level: 'Junior', score: 2 }, { level: 'Mid', score: 6 }, { level: 'Senior', score: 10 }],
    }];
    assert.ok(approx(calculateScore({ exp: 'Senior' }, criteria), 100));
    assert.ok(approx(calculateScore({ exp: 'Mid' }, criteria), 60));
    assert.ok(approx(calculateScore({ exp: 'Junior' }, criteria), 20));
    assert.equal(calculateScore({ exp: 'Ghost' }, criteria), 0); // unknown level
});

test('calculateScore: tiered with empty tiers array → 0, no crash', () => {
    const criteria = [{ id: 'x', type: 'tiered', weight: 1.0, tiers: [] }];
    assert.equal(calculateScore({ x: 'Senior' }, criteria), 0);
});

test('calculateScore: tiered with all-zero scores → 0, no crash', () => {
    const criteria = [{ id: 'x', type: 'tiered', weight: 1.0, tiers: [{ level: 'A', score: 0 }] }];
    assert.equal(calculateScore({ x: 'A' }, criteria), 0);
});

test('calculateScore: non-numeric string value for numeric criterion → 0', () => {
    const criteria = [{ id: 'a', type: 'numeric', weight: 1.0, min: 0, max: 10 }];
    assert.equal(calculateScore({ a: 'banana' }, criteria), 0);
});

test('QUIRK: numeric value above max is clamped', () => {
    const criteria = [{ id: 'a', type: 'numeric', weight: 1.0, min: 0, max: 10 }];
    assert.ok(approx(calculateScore({ a: 9999 }, criteria), 100));
});

test('QUIRK: numeric value below min is NOT clamped (negative scores possible)', () => {
    // If this test starts failing because someone added a Math.max clamp,
    // good — but remove this test and update the module-header note in
    // src/scoring.js first, so the docs stay accurate.
    const criteria = [{ id: 'a', type: 'numeric', weight: 1.0, min: 0, max: 10 }];
    assert.equal(calculateScore({ a: -5 }, criteria), -50);
});

test('QUIRK: yes_no is case-sensitive — "yes" (lowercase) scores 0', () => {
    const criteria = [{ id: 'a', type: 'yes_no', weight: 1.0 }];
    assert.equal(calculateScore({ a: 'yes' }, criteria), 0);
    assert.equal(calculateScore({ a: 'YES' }, criteria), 0);
    assert.equal(calculateScore({ a: 'Yes' }, criteria), 100);
});

test('weight given as string "0.3" is parsed correctly', () => {
    const criteria = [{ id: 'a', type: 'numeric', weight: '0.3', min: 0, max: 10 }];
    assert.ok(approx(calculateScore({ a: 10 }, criteria), 100));
});

test('unknown criterion type → skipped, does not throw', () => {
    const criteria = [
        { id: 'bogus', type: 'enum_with_colors', weight: 0.5 },
        { id: 'a', type: 'numeric', weight: 0.5, min: 0, max: 10 },
    ];
    // Total weight is 1.0 but only the numeric contributes. Score = (10/10) * 0.5 / 1.0 * 100 = 50
    assert.ok(approx(calculateScore({ a: 10, bogus: 'red' }, criteria), 50));
});

test('clampNumeric: bounds are enforced, non-numeric defaults to min', () => {
    assert.equal(clampNumeric(-5, 0, 10), 0);
    assert.equal(clampNumeric(9999, 0, 10), 10);
    assert.equal(clampNumeric(5, 0, 10), 5);
    assert.equal(clampNumeric('banana', 0, 10), 0);
    assert.equal(clampNumeric(undefined, 3, 10), 3);
    assert.equal(clampNumeric('7.5', 0, 10), 7.5);
});

test('normalizeYesNo: various truthy strings → "Yes"', () => {
    assert.equal(normalizeYesNo('Yes'), 'Yes');
    assert.equal(normalizeYesNo('yes'), 'Yes');
    assert.equal(normalizeYesNo('YES'), 'Yes');
    assert.equal(normalizeYesNo('y'), 'Yes');
    assert.equal(normalizeYesNo('true'), 'Yes');
    assert.equal(normalizeYesNo('1'), 'Yes');
    assert.equal(normalizeYesNo(true), 'Yes');
});

test('normalizeYesNo: everything else → "No"', () => {
    assert.equal(normalizeYesNo('No'), 'No');
    assert.equal(normalizeYesNo(''), 'No');
    assert.equal(normalizeYesNo('maybe'), 'No');
    assert.equal(normalizeYesNo(null), 'No');
    assert.equal(normalizeYesNo(undefined), 'No');
    assert.equal(normalizeYesNo(0), 'No');
});

test('perf: 1000 applicants × 10 criteria < 200ms', () => {
    const criteria = Array.from({ length: 10 }, (_, i) => ({
        id: `c${i}`, type: 'numeric', weight: 0.1, min: 0, max: 10,
    }));
    const apps = Array.from({ length: 1000 }, () => {
        const a = {};
        for (let i = 0; i < 10; i++) a[`c${i}`] = Math.random() * 10;
        return a;
    });
    const t0 = performance.now();
    for (const a of apps) calculateScore(a, criteria);
    const dt = performance.now() - t0;
    // Log to stderr so it shows up under `node --test` without confusing
    // the TAP parser.
    process.stderr.write(`  [perf] 1000 × 10 scored in ${dt.toFixed(2)}ms\n`);
    assert.ok(dt < 200, `scoring too slow: ${dt.toFixed(2)}ms`);
});
