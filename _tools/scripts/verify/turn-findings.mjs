// HOW AN ACTOR IS HELD TO ITS OWN FINDINGS AND TO NO OTHERS. Every caller asks each failing check the same question
// twice, once in the working tree and once in a snapshot of the commit the work is built on (check-snapshot.mjs), and
// this reads the second answer against the first. The base differs by caller and nothing here depends on which it is:
// the check after a land asks about the commit the land departed from (land-tiers.mjs), so a land answers for its own
// change; verify-push asks about the remote tip, so a push answers for its own range. Separate from them because it is the only part with no side effects, and so the
// only part a test can pin (turn-findings.test.mjs); getting it wrong is expensive in both directions, since a false
// accusation sends a conversation to rewrite code it never touched and a missed one leaves a new problem to nobody.
import { CHECKS } from "../../checks/manifest.mjs";

// WHAT A CHECK SAID, FINDING BY FINDING, so a change can be held to its own problems rather than to the tree's.
//
// A finding names a location, and that is what tells it apart from the prose around it: either a `- ` bullet (every
// check that reports through lib/report.mjs's `finish`) or a `path.ext:12` anchor (the ones that print their own, like
// path-literals and the UI tiers). Headings and explanatory epilogues name no location and are dropped — which is not
// cosmetic: a change that rewords a check's own failure message would otherwise be accused of every finding that
// message introduces, and rewording a message is not tightening a rule.
//
// Line numbers are flattened in the KEY: inserting a line above a standing finding moves it from `:180` to `:181`,
// which is the same problem. The key maps to the line as written, so what gets reported is the real anchor.
const FINDING = /^\s*-\s|[\w.-]+\.[a-z]+:\d+/;
const LINE_NUMBER = /:\d+/g;
export const problemLines = (verdict) =>
    new Map(
        `${verdict.stderr}${verdict.stdout}`
            .split("\n")
            .map((line) => line.trimEnd())
            .filter((line) => FINDING.test(line))
            .map((line) => [line.replace(LINE_NUMBER, ":#"), line]),
    );

// Whether the base snapshot was in a position to answer for this check at all. A check that `needs: "node_modules"` is
// blind in a snapshot that was not lent an install — i18n-literals reads no template there and passes vouching for
// nothing — and a check that exited "could not measure" (`measured: false`, lib/report.mjs's `cannotMeasure`) never
// looked either. Both print no findings for a reason that has nothing to do with the work under test.
export const blindAtBase = (verdict, lentModules) =>
    verdict.measured === false || (!lentModules && CHECKS.find((check) => check.id === verdict.id)?.needs === "node_modules");

/**
 * The caller's share of what the checks found: for each failing verdict, which of its lines the work under test is
 * answerable for.
 *
 * Three answers, because there are three facts and only two of them accuse. A line the snapshot printed too was already
 * standing, and a gate measures the tree it leaves behind, not the tree it found. A line the snapshot did not print is
 * new, and new is refused whatever the check's gate. And a line the snapshot was in no position to have printed —
 * because the check was blind there — is neither: it is reported and charged to nobody, the same distinction run.mjs
 * already draws for a live check that could not measure. Collapsing that third case into "new" is how a gate meant to
 * spare an actor other people's problems comes to guarantee it is blamed for every one of them.
 *
 * `before` is `undefined` when no snapshot could be taken at all; then everything is the caller's, which is the safe
 * direction to be wrong in — one actor is asked about lines it may not have written, rather than everything from here on
 * going unchecked.
 */
export const judgeAgainstBase = (failed, before) =>
    failed.map((verdict) => {
        const standing = before?.get(verdict.id);
        const unmatched = [...problemLines(verdict)].filter(([key]) => standing === undefined || !standing.lines.has(key)).map(([, line]) => line);
        if (standing?.blind === true) {
            return { verdict, added: [], unsure: unmatched };
        }
        // A check that PASSED on the base and fails now is the caller's whatever its lines look like: `unmatched` being
        // empty there would mean the check reports in a shape `FINDING` does not recognise, and the safe way to be wrong
        // about a new shape is to name the work that made it red, not to wave it through.
        const wholeCheck = standing?.ok === true && unmatched.length === 0;
        return { verdict, added: wholeCheck ? [`${verdict.id} passed before this change and fails now`] : unmatched, unsure: [] };
    });
