// HOW A TURN IS HELD TO ITS OWN FINDINGS AND TO NO OTHERS. verify-turn.mjs asks every failing check the same question
// twice — once in the working tree, once in a snapshot of HEAD — and this reads the second answer against the first.
// Separate from the gate because it is the only part of it with no side effects, and so the only part a test can pin
// (turn-findings.test.mjs); getting it wrong is expensive in both directions, since a false accusation sends a model to
// rewrite code it never touched and a missed one lets a new problem land.
import { CHECKS } from "../../checks/manifest.mjs";

// WHAT A CHECK SAID, FINDING BY FINDING, so a turn can be held to its own problems rather than to the tree's.
//
// A finding names a location, and that is what tells it apart from the prose around it: either a `- ` bullet (every
// check that reports through lib/report.mjs's `finish`) or a `path.ext:12` anchor (the ones that print their own, like
// path-literals and the UI tiers). Headings and explanatory epilogues name no location and are dropped — which is not
// cosmetic: a turn that rewords a check's own failure message would otherwise be accused of every finding that message
// introduces, and rewording a message is not tightening a rule.
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

// Whether the HEAD snapshot was in a position to answer for this check at all. A check that `needs: "node_modules"` is
// blind in a snapshot that was not lent an install — i18n-literals reads no template there and passes vouching for
// nothing — and a check that exited "could not measure" (`measured: false`, lib/report.mjs's `cannotMeasure`) never
// looked either. Both print no findings for a reason that has nothing to do with the turn.
export const blindAtHead = (verdict, lentModules) =>
    verdict.measured === false || (!lentModules && CHECKS.find((check) => check.id === verdict.id)?.needs === "node_modules");

/**
 * The turn's share of what the checks found: for each failing verdict, which of its lines this turn is answerable for.
 *
 * Three answers, because there are three facts and only two of them accuse. A line the snapshot printed too was already
 * standing, and the land measures the tree it leaves behind, not this turn. A line the snapshot did not print is new,
 * and new is refused whatever the check's gate. And a line the snapshot was in no position to have printed — because
 * the check was blind there — is neither: it is reported and charged to nobody, the same distinction run.mjs already
 * draws for a live check that could not measure. Collapsing that third case into "new" is how a gate meant to spare a
 * turn other people's problems comes to guarantee it is blamed for every one of them.
 *
 * `before` is `undefined` when no snapshot could be taken at all; then everything is the turn's, which is the safe
 * direction to be wrong in — one turn is asked about lines it may not have written, rather than every turn from here on
 * going unchecked.
 */
export const judgeAgainstHead = (failed, before) =>
    failed.map((verdict) => {
        const standing = before?.get(verdict.id);
        const unmatched = [...problemLines(verdict)].filter(([key]) => standing === undefined || !standing.lines.has(key)).map(([, line]) => line);
        if (standing?.blind === true) {
            return { verdict, added: [], unsure: unmatched };
        }
        // A check that PASSED at HEAD and fails now is this turn's whatever its lines look like: `unmatched` being empty
        // there would mean the check reports in a shape `FINDING` does not recognise, and the safe way to be wrong about
        // a new shape is to name the turn that made it red, not to wave it through.
        const wholeCheck = standing?.ok === true && unmatched.length === 0;
        return { verdict, added: wholeCheck ? [`${verdict.id} passed at HEAD and fails now`] : unmatched, unsure: [] };
    });
