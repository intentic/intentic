#!/usr/bin/env node
// No `check` script in a package whose scripts run `bun check`. Bun reads `bun check` as `bun run check` whenever the
// package.json where it runs has a script of that name, with `-p` and every other flag handed to the script, so the type
// checker never starts: the typecheck passes on whatever that script does. Name such a script anything else.
import { finish } from "./lib/report.mjs";
import { packages } from "./lib/repo.mjs";

const BUN_CHECK = /(^|[\s;&|(])bun check(\s|$)/;

const findings = [];
let checked = 0;
for (const { name, pkg } of packages) {
    const scripts = pkg.scripts ?? {};
    const runners = Object.entries(scripts).filter(([, command]) => BUN_CHECK.test(command));
    if (runners.length === 0) {
        continue;
    }
    checked += 1;
    if (scripts.check !== undefined) {
        findings.push(
            `${name}/package.json  its \`check\` script runs in place of \`bun check\` (from ${runners.map(([script]) => `"${script}"`).join(", ")}): rename the script`,
        );
    }
}

finish(
    [["A `check` script shadows the type checker", findings]],
    [`${checked} packages run \`bun check\`, none with a \`check\` script that would run instead`],
);
