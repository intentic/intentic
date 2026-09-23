// What one land added to the main tree, read against the commit it landed on: the push gate's cheap tiers, run while the
// conversation that landed it can still be sent back, each finding a unit (failure-units.mjs) charged to that land.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { changedSince } from "../lib/git.mjs";
import { weakenings } from "./assertion-ratchet.mjs";
import { checkVerdicts, reportsAt } from "./check-snapshot.mjs";
import { rustfmtAvailable, touchedCrates } from "./fixers.mjs";
import { judgeAgainstBase } from "./turn-findings.mjs";

// What oxlint reads, the same set `pnpm lint` reads at the push.
export const LINTABLE = /\.(m|c)?[jt]sx?$|\.vue$|\.astro$/;

const LINT_LINE = /^(.+?):\d+:\d+: (.*) \[\w+\/(.+)\]$/;

// oxlint's `unix` lines as units, line numbers dropped so an edit above a finding does not make it a new one.
export const lintUnits = (output) =>
    output.split("\n").flatMap((line) => {
        const found = LINT_LINE.exec(line.trim());
        return found === null ? [] : [`lint ${found[1]}: ${found[3]} ${found[2]}`];
    });

const lint = (root, files) => {
    if (files.length === 0) {
        return [];
    }
    const run = spawnSync("pnpm", ["lint", "--format=unix", ...files], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" });
    return run.status === 0 ? [] : lintUnits(`${run.stdout ?? ""}${run.stderr ?? ""}`);
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
    return judged.flatMap(({ verdict, added }) => added.map((line) => `tidy ${verdict.id}: ${line.trim().replace(/:\d+/g, ":#")}`));
};

const rustfmt = (root, changed) =>
    rustfmtAvailable(root)
        ? touchedCrates(root, changed).flatMap((crate) =>
              spawnSync("cargo", ["fmt", "--manifest-path", join(crate, "Cargo.toml"), "--all", "--check"], { cwd: root, stdio: "ignore" }).status === 0
                  ? []
                  : [`rustfmt ${crate}`],
          )
        : [];

// Every finding the tree added since `from`, lint and rustfmt over the files it touched, tidy and the ratchet over the range.
export const landTiers = (root, from) => {
    const changed = changedSince(root, from) ?? [];
    const { findings, declared } = weakenings(root, from);
    return [
        ...lint(
            root,
            changed.filter((path) => LINTABLE.test(path) && existsSync(join(root, path))),
        ),
        ...tidy(root, from),
        ...rustfmt(root, changed),
        ...(declared ? [] : findings.map((finding) => `ratchet ${finding.replace(/ \(.*\)$/, "")}`)),
    ];
};
