/*
 * ============================================================================
 *  src/scoring.js — Applicant scoring (pure logic, no DOM, no Firebase)
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before this refactor, the `calculateScore` function lived inside the giant
 * <script type="module"> block in `index.html`. That made it impossible to
 * test without launching a browser, and it meant every small change to the
 * scoring rules forced us to eyeball the ranked table to see if anything
 * broke. By extracting the pure logic into its own ES module we get two
 * things: (1) a single source of truth that both the UI and the test runner
 * import, and (2) the ability to assert scoring behavior in ~milliseconds
 * from Node with zero browser overhead.
 *
 * SCOPE
 * -----
 * This module exports ONE public function, `calculateScore`, plus a couple of
 * small helpers used during scoring. It deliberately contains no DOM access,
 * no Firebase calls, no fetch calls, and no side effects. Keep it that way —
 * anything that needs a browser or a network round trip belongs in
 * `index.html` or in a future `src/ai.js` / `src/firestore.js`. The moment
 * this file has a side effect, the unit tests stop being trustworthy.
 *
 * THE SCORING MODEL — IN PLAIN ENGLISH
 * ------------------------------------
 * Every applicant has a set of fields, one per criterion. A criterion can be
 * one of three "types":
 *
 *   - "numeric":   the value is a number between `min` and `max`.
 *   - "yes_no":    the value is the string "Yes" or "No".
 *   - "tiered":    the value is the level name (e.g. "Senior"), and the
 *                  criterion carries an array of {level, score} tiers.
 *
 * Each criterion also has a `weight` in the range [0, 1]. Conceptually the
 * weights should add up to 1.0, but we don't trust the user to enforce that,
 * so we normalize at the end: whatever weight sum the user actually has, we
 * divide by it. That means a single criterion with weight 0.5 and a perfect
 * score still yields 100, not 50. This is intentional — the UI shows a
 * warning when the weights don't sum to 1.00, so the user is informed, but
 * the ranking stays sensible either way.
 *
 * To compute the score for one applicant we walk the criteria list and for
 * each one we compute (criterionScore / maxPossibleScore) * weight, then
 * sum those contributions and divide by totalWeight, then scale by 100.
 * This normalization step is what makes scores comparable across different
 * criteria configurations.
 *
 * KNOWN BEHAVIOR QUIRKS (documented, not bugs)
 * --------------------------------------------
 *   - Numeric values ARE clamped against `max` but NOT against `min`. A user
 *     with value=-5 on a 0..10 criterion contributes -50 to the weighted
 *     sum. See the `clampNumeric` helper below for the fix that the UI
 *     layer should use before it ever reaches the DB.
 *   - "yes_no" is case-sensitive: only the exact string "Yes" scores. "yes"
 *     or "YES" score 0. The AI prompt explicitly asks for "Yes" or "No" so
 *     this is usually fine, but see `normalizeYesNo` below for a defensive
 *     helper we can apply at write time.
 *   - Unknown tier levels silently score 0. Empty tiers array scores 0 with
 *     no crash. All-zero tier scores score 0 with no crash.
 */

/**
 * Clamp a numeric value into [min, max]. Use this at the UI/DB boundary
 * when reading user input, so the stored value is always in range. The
 * scoring function itself does NOT call this — it trusts its inputs — so
 * legacy data with out-of-range values still computes deterministically.
 */
export const clampNumeric = (value, min = 0, max = 10) => {
    const n = parseFloat(value);
    if (Number.isNaN(n)) return min;
    if (n < min) return min;
    if (n > max) return max;
    return n;
};

/**
 * Normalize a yes/no answer coming from a user field or an AI response into
 * exactly the string "Yes" or "No" — the only two values the scoring
 * function recognizes. Anything truthy-looking ("y", "true", "1", "yes")
 * becomes "Yes"; everything else becomes "No". Apply this at write time,
 * not inside `calculateScore`, so the DB stays canonical.
 */
export const normalizeYesNo = (value) => {
    if (value === true) return 'Yes';
    if (typeof value !== 'string') return 'No';
    const v = value.trim().toLowerCase();
    return (v === 'yes' || v === 'y' || v === 'true' || v === '1') ? 'Yes' : 'No';
};

/**
 * Compute the 0..100 weighted score for a single applicant, given a list of
 * ranking criteria.
 *
 * Returns 0 — not NaN, not undefined — for every degenerate input: empty
 * criteria list, all-zero weights, missing values, all-zero tier scores, an
 * unknown tier level, etc. This matters because the UI sorts applicants by
 * score and calls `.toFixed(2)` on the result; a NaN would corrupt the table
 * and break the sort.
 *
 * @param {object} applicant  The applicant record. Its keys match criterion
 *                            IDs: `applicant[criterion.id]` is the value for
 *                            that criterion. The function also reads
 *                            `applicant.name`, `.email`, `.notes` — no wait,
 *                            it doesn't. Those are UI concerns only.
 * @param {Array}  criteria   The ranking criteria list (the same shape used
 *                            in Firestore: `{ id, name, weight, type, ... }`).
 * @returns {number}          A score in [0, 100], or a negative number if
 *                            legacy negative values are present (see quirks
 *                            above).
 */
export const calculateScore = (applicant, criteria) => {
    // Guard: no criteria means there is nothing to score against. Return 0
    // instead of dividing by zero below.
    if (!criteria || criteria.length === 0) return 0;

    // Total weight is computed once and reused as the normalization factor.
    // We `parseFloat` each weight because the config UI may write strings
    // (e.g. "0.3") into the record before a save, and we want those to work.
    let totalWeight = criteria.reduce(
        (sum, crit) => sum + (parseFloat(crit.weight) || 0),
        0
    );
    if (totalWeight === 0) return 0;

    let totalScore = 0;

    for (const criterion of criteria) {
        const value = applicant[criterion.id];
        let criterionScore = 0;
        let maxPossibleScore = 0;

        switch (criterion.type) {
            case 'numeric':
                // `max` can be any positive number. Clamp against max so a
                // user who types 9999 on a 0..10 scale doesn't dominate the
                // ranking. We do NOT clamp against min here — see the quirk
                // note in the module header. Use `clampNumeric` at write
                // time to prevent that case.
                maxPossibleScore = criterion.max || 10;
                criterionScore = Math.min(parseFloat(value) || 0, maxPossibleScore);
                break;

            case 'yes_no':
                // `yes_no` criteria are always normalized to a 0..10 scale
                // so they can be weighted against numeric criteria on equal
                // footing. "Yes" = 10, anything else = 0.
                maxPossibleScore = 10;
                criterionScore = (value === 'Yes') ? 10 : 0;
                break;

            case 'tiered': {
                // The max for a tiered criterion is the largest tier score
                // the user defined. If the tiers array is empty or every
                // tier has score 0, maxPossibleScore is 0 and we skip the
                // contribution entirely (dividing by 0 is bad).
                const tiers = criterion.tiers || [];
                maxPossibleScore = Math.max(...tiers.map(t => t.score), 0);
                if (maxPossibleScore === 0) break;
                const matchedTier = tiers.find(t => t.level === value);
                criterionScore = matchedTier ? matchedTier.score : 0;
                break;
            }

            default:
                // Unknown type → 0 contribution. We deliberately don't
                // throw here: a malformed criterion in Firestore shouldn't
                // break the whole ranking view.
                continue;
        }

        if (maxPossibleScore > 0) {
            totalScore += (criterionScore / maxPossibleScore) * criterion.weight;
        }
    }

    // Multiply by 100 at the end so downstream code can display a clean
    // "82.50" instead of "0.825". Dividing by totalWeight is what makes
    // non-1.0 weight totals still yield a sensible 0..100 number.
    return (totalScore / totalWeight) * 100;
};
