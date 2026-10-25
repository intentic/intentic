// Compares failing checks in the working tree with a base snapshot (check-snapshot.mjs) to report only added findings.
// The caller chooses the base, so this works for both a conversation's change and a pushed commit range.
// Kept side-effect-free so turn-findings.test.mjs can pin attribution without running checks or creating snapshots.
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// THE SAME FINDINGS AS A MULTISET, keyed by (path, rule, trimmed source): the flattened line names the path and the
// rule, and the source line it anchors to, read from `root`, tells two findings of one rule in one file apart. Two
// identical ones count twice, so a second empty catch added beside a standing one is the change's, which a set of keys
// cannot see and which only a per-file count baseline caught before. A finding with no `path:line` anchor, or whose file
// cannot be read at `root`, keys on its line alone.
const ANCHOR = /([\w./@-]+\.[a-z]+):(\d+)/;
// `renames` maps a path as the working tree now names it to the one the base knew it by, so a file the change only moved
// keeps the findings it had: they are read as they stood, not as new ones under another name.
export const findingCounts = (verdict, root, renames = new Map()) => {
    const asBaseKnew = (line) => [...renames].reduce((text, [now, before]) => text.replaceAll(now, before), line);
    const files = new Map();
    const sourceAt = (path, line) => {
        if (!files.has(path)) {
            let text;
            try {
                text = readFileSync(join(root, path), "utf8").split("\n");
            } catch {
                // allow(silent-catch): a finding whose file is gone or unreadable keys on its line alone
                text = undefined;
            }
            files.set(path, text);
        }
        return files.get(path)?.[line - 1]?.trim() ?? "";
    };
    const counts = new Map();
    for (const line of `${verdict.stderr}${verdict.stdout}`.split("\n").map((each) => each.trimEnd())) {
        if (!FINDING.test(line)) {
            continue;
        }
        const anchor = root === undefined ? null : ANCHOR.exec(line);
        const key = `${asBaseKnew(line).replace(LINE_NUMBER, ":#")}\0${anchor === null ? "" : sourceAt(anchor[1], Number(anchor[2]))}`;
        counts.set(key, [...(counts.get(key) ?? []), line]);
    }
    return counts;
};

// Whether the base snapshot was in a position to answer for this check at all. A check that `needs: "node_modules"` is
// blind in a snapshot that was not lent an install — i18n-literals reads no template there and passes vouching for
// nothing — and a check that exited "could not measure" (`measured: false`, lib/report.mjs's `cannotMeasure`) never
// looked either. Both print no findings for a reason that has nothing to do with the work under test.
export const blindAtBase = (verdict, lentModules) =>
    verdict.measured === false || (!lentModules && CHECKS.find((check) => check.id === verdict.id)?.needs === "node_modules");

// A count a finding states, standing alone between spaces or brackets: "31 files", "2 silent catch(es), the baseline
// allows 0". A number inside a path or a name (`file2.ts`, `TS2307`) is part of what the finding names, never a count.
const COUNT = /(?<=^|[\s(])\d+(?=$|[\s),;%])/g;
const uncounted = (key) => key.replace(COUNT, "#");
const countsIn = (key) => [...key.matchAll(COUNT)].map(([count]) => Number(count));

/** Whether a finding is one the base printed, at counts no higher: a directory that went from 32 files to 31 still
 *  holds too many, and that is the base's finding, made smaller, not the change's. A count that rose is the change's. */
export const noWorseThan = (key, baseKey) => {
    const now = countsIn(key);
    const before = countsIn(baseKey);
    return uncounted(key) === uncounted(baseKey) && now.length === before.length && now.every((count, index) => count <= (before[index] ?? -1));
};

// The live lines past what the base printed under their key, less those that are a base finding the base no longer
// matches only because its count fell: each base line the live run printed fewer of can stand for one such line, once.
const unmatchedLines = (live, held) => {
    const leftover = [...live].flatMap(([key, lines]) => lines.slice(held?.get(key)?.length ?? 0).map((line) => ({ key, line })));
    const spare = [...(held ?? new Map())].flatMap(([key, lines]) => Array.from({ length: Math.max(0, lines.length - (live.get(key)?.length ?? 0)) }, () => key));
    return leftover
        .filter(({ key }) => {
            const at = spare.findIndex((baseKey) => noWorseThan(key, baseKey));
            if (at === -1) {
                return true;
            }
            spare.splice(at, 1);
            return false;
        })
        .map(({ line }) => line);
};

/** Attribute failing lines as existing, added (refused for either gate), or unmeasurable at the base (reported without blame).
 * If before is undefined, no snapshot was possible: conservatively charge every finding to the caller.
 * renames maps new paths to base paths so moved files retain their existing findings. */
export const judgeAgainstBase = (failed, before, root, renames) =>
    failed.map((verdict) => {
        const standing = before?.get(verdict.id);
        // Each key's lines past as many as the base had: a finding the base printed as often is standing, one more is new.
        // A base read without source (no `findings`) is compared by its lines' keys alone, as it was taken.
        const held = standing?.findings ?? (standing === undefined ? undefined : findingCounts({ stderr: [...standing.lines.values()].join("\n"), stdout: "" }));
        const live = findingCounts(verdict, standing?.findings === undefined ? undefined : root, renames);
        const unmatched = unmatchedLines(live, held);
        if (standing?.blind === true) {
            return { verdict, added: [], unsure: unmatched };
        }
        // A check that PASSED on the base and fails now is the caller's whatever its lines look like: `unmatched` being
        // empty there would mean the check reports in a shape `FINDING` does not recognise, and the safe way to be wrong
        // about a new shape is to name the work that made it fail, not to wave it through.
        const wholeCheck = standing?.ok === true && unmatched.length === 0;
        return { verdict, added: wholeCheck ? [`${verdict.id} passed before this change and fails now`] : unmatched, unsure: [] };
    });
