#!/usr/bin/env node
// WHAT A PUSH LEAVES BEHIND. The pre-push hook never refuses (verify-push.mjs, `--advisory`), so everything it found used
// to scroll away with the terminal git printed it to, and the push had already gone. This writes it down instead: a
// report in the repository's git common dir, beside the verdicts lib/tree-verdict.mjs keeps, which the sandbox files once
// the push has reached the remote and the editor's Main line shows as "Left at push". A finding stays open until a later
// measurement no longer prints it, so every report also carries a measurement of every check and the linter, and the
// argv that takes the next one (`--recheck`, which writes an entry holding the measurement alone).
//
// The file is the contract with the daemon: a JSON array, newest first, at most REPORTS_KEPT entries of `version: 1`,
// each `{ id, at, kind: "push" | "recheck", remote?, pushes?, findings?, measured?, recheck }`. A finding names what
// measured it by `source` (a check's id, `lint`, …: this repository's words, which the daemon never interprets) and says
// whether a later measurement can clear it (`recheckable`); `kind`/`check` are written too, for a daemon that reads only them. A finding is matched
// against a later measurement by its KEY (findingKey), and `key: ""` means it has no line of its own: it clears only
// when its whole check passes.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../constants/src/node.mjs";
import { git } from "../lib/git.mjs";
import { checkVerdicts } from "./check-snapshot.mjs";
import { problemLines } from "./turn-findings.mjs";

export const REPORT_FILE = "intentic-push-report.json";
// Enough for the pushes between two times the daemon reads the file, which is at most minutes apart.
export const REPORTS_KEPT = 10;
// What the daemon runs, from the repository root, to measure the findings again.
export const RECHECK = ["node", "_tools/scripts/verify/push-report.mjs", "--recheck"];
// git calls one report may spend naming the commit behind its findings: a push that trips a check on hundreds of lines
// still has to reach the remote in seconds, and the first sixty are the ones anybody reads.
const ATTRIBUTION_CALLS = 60;

/**
 * The same finding whatever moved around it: whitespace collapsed and every run of digits one `#`, so `a.ts:127  x` and
 * `a.ts:128 x` are one key, and so are `3 silent catch(es)` and `2 silent catch(es)`. Coarser than turn-findings.mjs's
 * own key (which flattens only `:12` anchors) on purpose: that one tells a push's new lines from standing ones in the
 * same minute, this one has to recognise a finding in a measurement taken days and several edits later.
 */
export const findingKey = (line) => line.trim().replace(/\s+/g, " ").replace(/\d+/g, "#");

export const checkCommand = (id) => `node _tools/checks/run.mjs --only ${id}`;

// A code-gate check the tree fails, one finding per line it printed. A check whose output has no line in a shape
// problemLines recognises is still named, by its first line, with no key: nothing short of it passing can clear it.
export const brokenFindings = (verdict) => {
    const base = { kind: "check", check: verdict.id, source: verdict.id, recheckable: true, gate: "code", command: checkCommand(verdict.id) };
    const lines = [...problemLines(verdict).values()];
    if (lines.length === 0) {
        const first = `${verdict.stderr ?? ""}${verdict.stdout ?? ""}`
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line !== "");
        return [{ ...base, text: first ?? `${verdict.id} fails`, key: "" }];
    }
    return lines.map((line) => ({ ...base, text: line.trim(), key: findingKey(line) }));
};

// The tidy lines this push introduced (judgeAgainstBase's `added`), and none of the rest: a line already failing at the
// base is not this push's, and one the base could not be asked about is charged to nobody. `added` may hold the
// whole-check line (a check that passed at the base and fails in a shape with no finding lines), which is no line the
// check printed, so it gets no key.
export const tidyFindings = (judged) =>
    judged.flatMap(({ verdict, added }) => {
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

// The failed steps lib/steps.mjs ran or recorded that are findings of their own; the checkout gates and tidiness are
// already findings line by line (above), so they are not counted twice. The linter's finding is keyless: only the
// linter passing clears it.
const STEP_KINDS = [
    [/^assertion ratchet\b/, "ratchet"],
    [/^manifest\/lockfile lockstep$/, "lockstep"],
    [/^lint$/, "lint"],
    [/^cargo fmt --check\b/, "rustfmt"],
];
export const stepFindings = (failed) =>
    failed.flatMap(({ label, why, spelling }) => {
        const kind = STEP_KINDS.find(([pattern]) => pattern.test(label))?.[1];
        if (kind === undefined) {
            return [];
        }
        const text = `${label}: ${why}`;
        // Only the linter can be measured again; the ratchet, the lockstep and rustfmt are about the pushed commits.
        return [
            {
                kind,
                source: kind,
                recheckable: kind === "lint",
                text,
                key: kind === "lint" ? "" : findingKey(text),
                ...(spelling === undefined ? {} : { command: spelling }),
            },
        ];
    });

// `pnpm lint`'s outcome from its spawn, or undefined when it could not run at all (no pnpm): that is not a pass.
export const lintOutcome = (result) => (result.error !== undefined ? undefined : result.status === 0 ? "passed" : "failed");

// What every check and the linter said, keyed the way findings are, so a finding recorded at any earlier push can be
// read against it: gone from `keys` of a measured check (or the check passing) is resolved.
export const measuredOf = (verdicts, lint) => ({
    checks: Object.fromEntries(
        (verdicts ?? []).map((verdict) => [
            verdict.id,
            {
                ok: verdict.ok === true,
                measured: verdict.measured !== false,
                keys: verdict.ok === true ? [] : [...new Set([...problemLines(verdict).values()].map(findingKey))],
            },
        ]),
    ),
    ...(lint === undefined ? {} : { lint }),
});

// A repository-relative path named in a finding: `a/b.ts`, `a/b.ts:12`, `.githooks/pre-push`, a directory `a/b:`, or a
// bare `pnpm-lock.yaml`. Never one starting inside another path, so `../x/y` and `/abs/x` name nothing.
const PATH_TOKEN = /(?<![\w@./+-])(?:\.?[\w@+-][\w@.+-]*(?:\/[\w@.+-]+)+|\.?[\w@+-][\w@+-]*\.[A-Za-z]\w*)/g;

// The paths `text` names that exist in this checkout. A check that prints paths relative to its own package
// (daemon-boundaries says `portability/definition.ts`) names nothing here, rather than whatever sits at that path from
// the root.
export const pathsIn = (root, text) =>
    [...new Set([...text.replaceAll(`${root}/`, "").matchAll(PATH_TOKEN)].map(([token]) => token.replace(/\.+$/, "")))].filter(
        (path) => path !== "" && !path.split("/").includes("..") && existsSync(join(root, path)),
    );

/**
 * Each finding with the newest pushed commit that touched a path it names, `{ sha, subject }`, so whoever reads it later
 * knows which change to open. Only within a push's own `base..head`: a push with no base (a new branch) names no commit
 * rather than every commit the branch ever had.
 */
export const attributeCommits = (root, findings, pushes, budget = ATTRIBUTION_CALLS) => {
    const ranges = pushes.filter(({ base, head }) => base !== undefined && base !== head).map(({ base, head }) => `${base}..${head}`);
    if (ranges.length === 0) {
        return findings;
    }
    const asked = new Map();
    let left = budget;
    const newest = (path) => {
        for (const range of ranges) {
            const question = `${range}\0${path}`;
            if (!asked.has(question)) {
                if (left === 0) {
                    return undefined;
                }
                left -= 1;
                const [sha, subject] = (git(root, "log", "-1", "--format=%h%x1f%s", range, "--", path) ?? "").trim().split("\x1f");
                asked.set(question, sha === "" ? undefined : { sha, subject: subject ?? "" });
            }
            const found = asked.get(question);
            if (found !== undefined) {
                return found;
            }
        }
        return undefined;
    };
    return findings.map((finding) => {
        for (const path of pathsIn(root, finding.text)) {
            const commit = newest(path);
            if (commit !== undefined) {
                return { ...finding, commit };
            }
        }
        return finding;
    });
};

// One finding per problem, the first as printed. The daemon names a finding by what measured it, its check and its key
// (its text when keyless), so two lines that differ only in their digits are one finding there, and two of them in
// one report would be one finding filed twice.
export const distinctFindings = (findings) => {
    const seen = new Set();
    return findings.filter(({ kind, check, key, text }) => {
        const identity = `${kind}\0${check ?? ""}\0${key === "" ? text : key}`;
        if (seen.has(identity)) {
            return false;
        }
        seen.add(identity);
        return true;
    });
};

// `[{ ref, head, base? }]` as the report names them: the remote ref, the pushed sha, and how many commits the push
// carries over its base (0 with no base to count from).
export const describePushes = (root, pushes) =>
    pushes.map(({ ref, head, base }) => {
        const counted = base === undefined ? 0 : Number(git(root, "rev-list", "--count", `${base}..${head}`)?.trim());
        return { ref, head, ...(base === undefined ? {} : { base }), commits: Number.isInteger(counted) ? counted : 0 };
    });

export const reportId = (at) => `${at.toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;

// The hook's first argument is the remote's NAME, or its URL when the push named one directly: a URL (which may carry
// credentials) is not what anybody wants to read back, and `origin` is.
const remoteName = (remote) => (remote === undefined || remote === "" || /[:/\\]/.test(remote) ? undefined : remote);

// One push's entry; `pushes` are `[{ ref, head, base? }]`, `findings` what brokenFindings, tidyFindings and stepFindings
// made of the run, `verdicts` checkVerdicts' answer and `lint` lintOutcome's.
export const pushEntry = (root, { remote, pushes, findings, verdicts, lint, at = Date.now() }) => {
    const described = describePushes(root, pushes);
    const name = remoteName(remote);
    return {
        version: 1,
        id: reportId(at),
        at,
        kind: "push",
        ...(name === undefined ? {} : { remote: name }),
        pushes: described,
        findings: attributeCommits(root, distinctFindings(findings), described),
        measured: measuredOf(verdicts, lint),
        recheck: RECHECK,
    };
};

// A measurement with no push behind it (a recheck, or `pnpm verify:push` run by hand): it can clear what earlier pushes
// left, and records nothing of its own, since nothing went anywhere for a finding to have been let through with.
export const measureEntry = (verdicts, lint, at = Date.now()) => ({
    version: 1,
    id: reportId(at),
    at,
    kind: "recheck",
    measured: measuredOf(verdicts, lint),
    recheck: RECHECK,
});

export const reportPath = (root) => {
    const dir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")?.trim();
    return dir === undefined ? undefined : join(dir, REPORT_FILE);
};

const readAt = (path) => {
    let text;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if (error?.code === "ENOENT") {
            return [];
        }
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        // allow(silent-catch): a report this cannot parse, the daemon cannot either, so its entries are lost to both already;
        // starting the file over is what lets the next push be read at all.
        return [];
    }
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry)) : [];
};

// The entries on file, newest first; none when git cannot name the common dir.
export const readReports = (root) => {
    const path = reportPath(root);
    return path === undefined ? [] : readAt(path);
};

/**
 * Puts `entry` first and keeps REPORTS_KEPT. Never throws: `{ ok: true, path }` or `{ ok: false, why }`, since the
 * caller is a push that goes either way and must not be stopped by its own bookkeeping.
 */
export const writeReport = (root, entry) => {
    const path = reportPath(root);
    if (path === undefined) {
        return { ok: false, why: "git could not name this repository's common dir" };
    }
    // Written aside and renamed over, so a reader never sees half a file; the pid keeps two pushes' scratch files apart.
    const scratch = `${path}.${process.pid}.tmp`;
    try {
        writeFileSync(scratch, `${JSON.stringify([entry, ...readAt(path)].slice(0, REPORTS_KEPT))}\n`);
        renameSync(scratch, path);
        return { ok: true, path };
    } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        try {
            rmSync(scratch, { force: true });
        } catch (cleanup) {
            return { ok: false, why: `${why} (and ${scratch} is left behind: ${cleanup instanceof Error ? cleanup.message : String(cleanup)})` };
        }
        return { ok: false, why };
    }
};

// THE RECHECK: the same measurement a push takes, without a push, so a finding fixed since can be seen to be gone. The
// daemon runs it (RECHECK) when the owner asks and after a land check; it writes the measurement alone and exits 0 either
// way, since what it measured is the answer and a red tree is not a failure to measure.
const recheck = (root) => {
    const verdicts = checkVerdicts(root);
    const lint = lintOutcome(spawnSync("pnpm", ["lint"], { cwd: root, stdio: "ignore", shell: process.platform === "win32" }));
    const checks = verdicts === undefined ? "checks could not be measured" : `${verdicts.filter(({ ok }) => !ok).length} of ${verdicts.length} checks fail`;
    const linted = lint === undefined ? "lint could not run" : `lint ${lint}`;
    if (verdicts === undefined && lint === undefined) {
        console.error(`push-report: ${checks} and ${linted}, so nothing was measured and nothing is written`);
        return;
    }
    const written = writeReport(root, measureEntry(verdicts, lint));
    console.error(`push-report: ${checks}, ${linted}; ${written.ok ? `kept in ${written.path}` : `could not be kept: ${written.why}`}`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    if (!process.argv.includes("--recheck")) {
        console.error("usage: push-report.mjs --recheck");
        process.exit(2);
    }
    recheck(repoRoot(import.meta.url));
}
