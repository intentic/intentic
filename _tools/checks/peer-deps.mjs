#!/usr/bin/env node
// An unmet peer is a version mismatch the type-checker and the test run can both miss: the import resolves, to a copy
// of the wrong major. `pnpm peers check` reads the issues out of the lockfile, so this costs no install and no
// re-resolution — `--lockfile-only` is what keeps it a checkout-only check. It replaces `install --resolution-only`,
// the flag pnpm 12 removed.
// The one tool this check needs beyond node: pnpm itself, on PATH at the pinned version. A hosted runner has none
// unless the job installs it, and a missing binary reads nothing like a moved output shape, so the two are told apart
// below rather than reported as one puzzle.
import { execFileSync } from "node:child_process";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { root } from "./lib/repo.mjs";

// `intersections` is pnpm reporting where it narrowed overlapping peer ranges — an outcome, not a problem. The three
// below are the problems: a peer resolved outside its range, a peer nothing installed, and two dependents demanding
// ranges that cannot both hold.
const FAULTS = ["bad", "missing", "conflicts"];

const read = () => {
    try {
        return JSON.parse(
            execFileSync("pnpm", ["peers", "check", "--json", "--lockfile-only"], {
                cwd: root,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }),
        );
    } catch (error) {
        // A non-zero exit still prints the report, so issues arrive here rather than as a thrown check.
        const printed = error.stdout?.trim();
        if (printed) {
            try {
                return JSON.parse(printed);
            } catch {
                /* fall through to the unreadable case */
            }
        }
        return error.code === "ENOENT" ? "no-pnpm" : undefined;
    }
};

const report = read();
// Neither of these is a finding about the tree, so neither is reported as one: this check did not look. Saying so in
// its own voice is what keeps a broken tool from reading as an untidy repository — the shape that reddened
// `nightly.yml`'s tidy job on a tree with nothing wrong in it.
if (report === "no-pnpm") {
    cannotMeasure("pnpm is not on PATH, so the lockfile's peers went unread: the job running this check has to install pnpm before it");
}
if (report === undefined) {
    cannotMeasure("`pnpm peers check --json --lockfile-only` produced no readable report: the command or its output shape moved and this check needs rewriting");
}
const unmet = [];
for (const [importer, issues] of Object.entries(report)) {
    for (const fault of FAULTS) {
        const found = issues?.[fault];
        const names = Array.isArray(found) ? found : Object.keys(found ?? {});
        for (const name of names) {
            unmet.push(`${importer}: ${typeof name === "string" ? name : JSON.stringify(name)} (${fault})`);
        }
    }
}

finish(
    [["Peer dependencies the lockfile does not satisfy, so an import resolves to the wrong copy", unmet]],
    [`peer dependencies: ${Object.keys(report).length} importers, none with an unmet, missing or conflicting peer`],
);
