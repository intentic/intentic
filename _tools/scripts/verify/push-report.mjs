#!/usr/bin/env node
// WHAT A PUSH LEAVES BEHIND. The pre-push hook never refuses (verify-push.mjs, `--advisory`), so everything it found used
// to scroll away with the terminal git printed it to, and the push had already gone. This writes it down instead: a
// report in the repository's git common dir, beside the verdicts lib/tree-verdict.mjs keeps, which the sandbox files once
// the push has reached the remote and the editor's Main line shows as "Left at push". A finding stays open until a later
// measurement no longer prints it, so every report also carries a measurement of every check and the linter, and the
// argv that takes the next one (`--recheck`, which writes an entry holding the measurement alone).
//
// The file is the contract with the daemon (lib/push-store.mjs holds it, beside the tree verdicts): a JSON array, newest
// first, at most REPORTS_KEPT report entries of `version: 1`, each `{ id, at, kind: "push" | "recheck", remote?,
// pushes?, findings?, measured?, recheck }`; the daemon reads past every other kind. A finding names what
// measured it by `source` (a check's id, `lint`, …: this repository's words, which the daemon never interprets) and says
// whether a later measurement can clear it (`recheckable`); `kind`/`check` are written too, for a daemon that reads only them. A finding is matched
// against a later measurement by its KEY (findingKey), and `key: ""` means it has no line of its own: it clears only
// when its whole check passes.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../constants/src/node.mjs";
import { git } from "../lib/git.mjs";
import { readStore, storePath, writeStore } from "../lib/push-store.mjs";
import { checkVerdicts } from "./check-snapshot.mjs";
import { checkCommand, findingKey, runLint } from "./measure-change.mjs";
import { problemLines } from "./turn-findings.mjs";

// One definition each, measure-change.mjs's: every caller keys, spells and reads a tidy finding the same way.
export { checkCommand, findingKey, tidyFindings } from "./measure-change.mjs";

export { REPORTS_KEPT, STORE_FILE as REPORT_FILE } from "../lib/push-store.mjs";
// What the daemon runs, from the repository root, to measure the findings again.
export const RECHECK = ["node", "_tools/scripts/verify/push-report.mjs", "--recheck"];
// git calls one report may spend naming the commit behind its findings: a push that trips a check on hundreds of lines
// still has to reach the remote in seconds, and the first sixty are the ones anybody reads.
const ATTRIBUTION_CALLS = 60;

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

// The failed steps lib/steps.mjs ran or recorded that are findings of their own; the checkout gates, tidiness and the
// linter are already findings line by line (measure-change.mjs), so they are not counted twice.
const STEP_KINDS = [
    [/^assertion ratchet\b/, "ratchet"],
    [/^manifest\/lockfile lockstep$/, "lockstep"],
    [/^cargo fmt --check\b/, "rustfmt"],
];
export const stepFindings = (failed) =>
    failed.flatMap(({ label, why, spelling }) => {
        const kind = STEP_KINDS.find(([pattern]) => pattern.test(label))?.[1];
        if (kind === undefined) {
            return [];
        }
        const text = `${label}: ${why}`;
        // The ratchet, the lockstep and rustfmt are about the pushed commits, so no later measurement clears them.
        const finding = { kind, source: kind, recheckable: false, text, key: findingKey(text) };
        if (spelling !== undefined) {
            finding.command = spelling;
        }
        return [finding];
    });

// What every check and the linter said, keyed the way findings are, so a finding recorded at any earlier push can be
// read against it: gone from `keys` of a measured source (or the source passing) is resolved. `lint` is runLint's answer
// (measure-change.mjs); it is kept as a source among the checks, and as the passed/failed the first daemons read.
export const measuredOf = (verdicts, lint) => ({
    checks: {
        ...Object.fromEntries(
            (verdicts ?? []).map((verdict) => [
                verdict.id,
                {
                    ok: verdict.ok === true,
                    measured: verdict.measured !== false,
                    keys: verdict.ok === true ? [] : [...new Set([...problemLines(verdict).values()].map(findingKey))],
                },
            ]),
        ),
        ...(lint === undefined ? {} : { lint: { ok: lint.ran && lint.findings.length === 0, measured: lint.ran, keys: [...new Set(lint.findings.map(({ key }) => key))] } }),
    },
    ...(lint === undefined || !lint.ran ? {} : { lint: lint.findings.length === 0 ? "passed" : "failed" }),
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
// made of the run, `verdicts` checkVerdicts' answer and `lint` runLint's (measure-change.mjs).
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

// The store the report lives in, shared with the tree verdicts (lib/push-store.mjs).
export const reportPath = storePath;

// The push and recheck entries on file, newest first; none when git cannot name the common dir.
export const readReports = (root) => readStore(root).filter((entry) => entry.kind !== "verdict");

/** Puts `entry` first; never throws (lib/push-store.mjs, writeStore). */
export const writeReport = (root, entry) => writeStore(root, entry);

// THE RECHECK: the same measurement a push takes, without a push, so a finding fixed since can be seen to be gone. The
// daemon runs it (RECHECK) when the owner asks and after a land check; it writes the measurement alone and exits 0 either
// way, since what it measured is the answer and a red tree is not a failure to measure.
const recheck = (root) => {
    const verdicts = checkVerdicts(root);
    const lint = runLint(root);
    const checks = verdicts === undefined ? "checks could not be measured" : `${verdicts.filter(({ ok }) => !ok).length} of ${verdicts.length} checks fail`;
    const linted = lint.ran ? `lint ${lint.findings.length === 0 ? "passed" : `found ${lint.findings.length}`}` : "lint could not run";
    if (verdicts === undefined && !lint.ran) {
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
