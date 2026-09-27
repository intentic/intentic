// ONE READING OF WHAT A CHANGE BROUGHT IN, as typed findings: the push asks it of the pushed range (verify-push.mjs,
// against the merge-base with the remote), and the push recheck measures the tree's linter with the same reading
// (push-report.mjs), so the measurement that clears a finding names it the way the push that left it did.
//
// A finding is the push report's shape (push-report.mjs): `source` (what measured it, this repository's word), `text` as
// printed, `key` (position-free, what a later measurement names it by), `recheckable`, and the `kind`/`check` an older
// daemon reads.
import { spawnSync } from "node:child_process";
import { allowedInRange } from "../../checks/lib/allow.mjs";
import { reportsAt } from "./check-snapshot.mjs";
import { judgeAgainstBase, problemLines } from "./turn-findings.mjs";

// `[Error/rule]` for a rule's finding, bare `[Error]` for a file oxlint could not parse at all.
const LINT_LINE = /^(.+?):\d+:\d+: (.*) \[\w+(?:\/(.+))?\]$/;

export const LINT_COMMAND = "pnpm lint";

// The one reading of oxlint's `unix` lines: a finding per line, keyed without the position, so an edit above a finding
// does not make it a new one.
export const lintFindings = (output) =>
    output.split("\n").flatMap((line) => {
        const found = LINT_LINE.exec(line.trim());
        if (found === null) {
            return [];
        }
        const key = `lint ${found[1]}: ${found[3] ?? "parse"} ${found[2]}`;
        return [{ kind: "lint", source: "lint", recheckable: true, text: line.trim(), key, path: found[1], command: LINT_COMMAND }];
    });

/**
 * The linter over `files` (every lintable file when omitted), one way for every caller: `{ ran, findings }`. `ran` is
 * false when the linter could not run at all (no pnpm, or a red exit with no finding in it), which is not a pass.
 */
export const runLint = (root, files) => {
    if (files !== undefined && files.length === 0) {
        return { ran: true, findings: [] };
    }
    const run = spawnSync("pnpm", ["lint", "--format=unix", ...(files ?? [])], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        shell: process.platform === "win32",
    });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    // oxlint exits 1 with this when every path it was handed is one its config ignores: nothing to find.
    if (run.status === 0 || /No files found to lint/.test(output)) {
        return { ran: run.error === undefined, findings: [] };
    }
    const findings = lintFindings(output);
    return findings.length > 0 ? { ran: true, findings } : { ran: false, findings: [], why: run.error?.message ?? `exit ${run.status ?? "signal"} with no finding` };
};

/**
 * The tidy checks the tree fails, judged against `base` (turn-findings.mjs) with the range's `Allow:` trailers applied
 * (lib/allow.mjs): `mine` (what the change added and nothing excuses), `excused` (added, and a trailer in the range
 * accepts it, with its reasons), `unsure` (lines `base` could not be asked about, charged to nobody) and `theirs`
 * (already failing at `base`, no worse for the change).
 */
export const judgeTidy = (root, base, untidy) => {
    if (untidy.length === 0) {
        return { mine: [], excused: [], unsure: [], theirs: [] };
    }
    const judged = judgeAgainstBase(
        untidy,
        reportsAt(
            root,
            base,
            untidy.map(({ id }) => id),
        ),
        root,
    );
    const allowed = allowedInRange(root, base);
    return {
        mine: judged.filter(({ verdict, added }) => added.length > 0 && !allowed.has(verdict.id)),
        excused: judged.filter(({ verdict, added }) => added.length > 0 && allowed.has(verdict.id)).map((each) => ({ ...each, reasons: allowed.get(each.verdict.id) })),
        unsure: judged.filter(({ added, unsure }) => added.length === 0 && unsure.length > 0),
        theirs: judged.filter(({ added, unsure }) => added.length === 0 && unsure.length === 0),
    };
};

// The key a later measurement names a check's line by: whitespace collapsed and every run of digits one `#`, so the same
// finding is recognised days and several edits later (push-report.mjs measures with it too).
export const findingKey = (line) => line.trim().replace(/\s+/g, " ").replace(/\d+/g, "#");

export const checkCommand = (id) => `node _tools/checks/run.mjs --only ${id}`;

// The tidy lines a change added, as findings. A line that is the whole-check message (a check that passed at the base
// and fails in a shape with no finding lines) is no line the check printed, so it gets no key.
export const tidyFindings = (mine) =>
    mine.flatMap(({ verdict, added }) => {
        const printed = new Set(problemLines(verdict).values());
        return added.map((line) => ({
            kind: "check",
            check: verdict.id,
            source: verdict.id,
            recheckable: true,
            gate: "tidy",
            text: line.trim(),
            key: printed.has(line) ? findingKey(line) : "",
            command: checkCommand(verdict.id),
        }));
    });
