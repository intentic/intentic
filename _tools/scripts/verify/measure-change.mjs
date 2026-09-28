// ONE READING OF WHAT A RANGE BROUGHT IN, for the push check (verify-push.mjs): the linter's findings, one per line it
// printed, and the tidy checks the tree fails judged against the commit the range is built on.
import { spawnSync } from "node:child_process";
import { allowedInRange } from "../../checks/lib/allow.mjs";
import { reportsAt } from "./check-snapshot.mjs";
import { judgeAgainstBase } from "./turn-findings.mjs";

// `[Error/rule]` for a rule's finding, bare `[Error]` for a file oxlint could not parse at all.
const LINT_LINE = /^(.+?):\d+:\d+: (.*) \[\w+(?:\/(.+))?\]$/;

export const LINT_COMMAND = "pnpm lint";

// The one reading of oxlint's `unix` lines: a finding per line, as printed, with the file it names. Its summary line
// ("2 problems") is none.
export const lintFindings = (output) =>
    output.split("\n").flatMap((line) => {
        const found = LINT_LINE.exec(line.trim());
        return found === null ? [] : [{ text: line.trim(), path: found[1] }];
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
