// What one land added to the main tree, read against the commit it landed on: the push gate's cheap tiers, run while the
// conversation that landed it can still be sent back, each finding a unit (failure-units.mjs) charged to that land.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { allowedInRange } from "../../checks/lib/allow.mjs";
import { addedPluginFindings } from "../../oxlint/added.mjs";
import { changedSince } from "../lib/git.mjs";
import { weakenings } from "./assertion-ratchet.mjs";
import { checkVerdicts, reportsAt } from "./check-snapshot.mjs";
import { rustfmtAvailable, touchedCrates } from "./fixers.mjs";
import { judgeAgainstBase } from "./turn-findings.mjs";

// What oxlint reads, the same set `pnpm lint` reads at the push.
export const LINTABLE = /\.(m|c)?[jt]sx?$|\.vue$|\.astro$/;

// `[Error/rule]` for a rule's finding, bare `[Error]` for a file oxlint could not parse at all.
const LINT_LINE = /^(.+?):\d+:\d+: (.*) \[\w+(?:\/(.+))?\]$/;

// oxlint's `unix` lines as units, line numbers dropped so an edit above a finding does not make it a new one.
export const lintUnits = (output) =>
    output.split("\n").flatMap((line) => {
        const found = LINT_LINE.exec(line.trim());
        return found === null ? [] : [`lint ${found[1]}: ${found[3] ?? "parse"} ${found[2]}`];
    });

const lint = (root, files) => {
    if (files.length === 0) {
        return [];
    }
    const run = spawnSync("pnpm", ["lint", "--format=unix", ...files], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    // oxlint exits 1 with this when every path it was handed is one its config ignores: nothing to find.
    if (run.status === 0 || /No files found to lint/.test(output)) {
        return [];
    }
    const units = lintUnits(output);
    // A red exit with no finding in it is a linter that did not run, and "nothing added" is not what it said.
    return units.length > 0 ? units : [`lint could not run: ${run.error?.message ?? `exit ${run.status ?? "signal"} with no finding`}`];
};

// Tidy lines the tree holds that `from` did not; a code failure is the land verify's own `checkout gates` step's to refuse.
const tidy = (root, from) => {
    const untidy = (checkVerdicts(root) ?? []).filter((verdict) => !verdict.ok && verdict.measured && verdict.gate === "tidy");
    if (untidy.length === 0) {
        return [];
    }
    const judged = judgeAgainstBase(
        untidy,
        reportsAt(
            root,
            from,
            untidy.map(({ id }) => id),
        ),
    );
    // An `Allow: <check> — <reason>` trailer in the range accepts what the land adds to that check (lib/allow.mjs).
    const allowed = allowedInRange(root, from);
    return judged
        .filter(({ verdict }) => !allowed.has(verdict.id))
        .flatMap(({ verdict, added }) => added.map((line) => `tidy ${verdict.id}: ${line.trim().replace(/:\d+/g, ":#")}`));
};

const rustfmt = (root, changed) =>
    rustfmtAvailable(root)
        ? touchedCrates(root, changed).flatMap((crate) =>
              spawnSync("cargo", ["fmt", "--manifest-path", join(crate, "Cargo.toml"), "--all", "--check"], { cwd: root, stdio: "ignore" }).status === 0
                  ? []
                  : [`rustfmt ${crate}`],
          )
        : [];

// Every finding the tree added since `from`: lint (the root rules whole, the plugin tier by what was added) and rustfmt
// over the files it touched, tidy and the ratchet over the range.
export const landTiers = (root, from) => {
    const changed = changedSince(root, from) ?? [];
    const measured = weakenings(root, from);
    const lintable = changed.filter((path) => LINTABLE.test(path) && existsSync(join(root, path)));
    return [
        ...lint(root, lintable),
        // The plugin rules have a backlog, so only what the land added to its files counts (_tools/oxlint/added.mjs).
        ...addedPluginFindings(root, from, lintable),
        ...tidy(root, from),
        ...rustfmt(root, changed),
        ...(measured === undefined
            ? [`ratchet could not measure: git could not list the test files changed since ${from.slice(0, 9)}`]
            : measured.declared
              ? []
              : measured.findings.map((finding) => `ratchet ${finding.replace(/ \(.*\)$/, "")}`)),
    ];
};
