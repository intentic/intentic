#!/usr/bin/env node
// An unmet peer is a version mismatch the type-checker and the test run can both miss: the import resolves, to a copy
// of the wrong major. `pnpm peers check` reads the issues out of the lockfile, so this costs no install and no
// re-resolution — `--lockfile-only` is what keeps it a checkout-only check. It replaces `install --resolution-only`,
// the flag pnpm 12 removed.
import { execFileSync } from "node:child_process";
import { finish } from "./lib/report.mjs";
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
        return undefined;
    }
};

const report = read();
const unmet = [];
if (report === undefined) {
    unmet.push(
        "`pnpm peers check --json --lockfile-only` produced no readable report: the command or its output shape moved and this check needs rewriting",
    );
} else {
    for (const [importer, issues] of Object.entries(report)) {
        for (const fault of FAULTS) {
            const found = issues?.[fault];
            const names = Array.isArray(found) ? found : Object.keys(found ?? {});
            for (const name of names) {
                unmet.push(`${importer}: ${typeof name === "string" ? name : JSON.stringify(name)} (${fault})`);
            }
        }
    }
}

finish(
    [["Peer dependencies the lockfile does not satisfy, so an import resolves to the wrong copy", unmet]],
    [`peer dependencies: ${Object.keys(report ?? {}).length} importers, none with an unmet, missing or conflicting peer`],
);
