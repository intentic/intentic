#!/usr/bin/env node
// Checks that PUB (_tools/scripts/lib/packages.sh, hand-maintained) is dependency-closed and topologically ordered: an
// unlisted workspace dependency packs an unresolvable specifier, and publish-npm.sh publishes serially in PUB order.
// Reads the list out of the shell file (packages.mjs) so this runs without bash in the path.
//
// What it CANNOT see is whether npm has ever heard of these names — that answer needs the registry, so it is read at
// release time instead, by _tools/scripts/release/check-publishable.mjs.
import { finish } from "./lib/report.mjs";
import { manifestOf, publishSet } from "../scripts/lib/packages.mjs";

const given = process.argv.slice(2).filter((arg) => arg !== "--");
const dirs = given.length > 0 ? given : publishSet();
if (dirs === undefined) {
    console.error("publish set: could not read PUB out of _tools/scripts/lib/packages.sh, the shape changed and this check needs updating");
    process.exit(1);
}

const position = new Map(dirs.map((dir, index) => [manifestOf(dir).name, index]));

const problems = [];
for (const dir of dirs) {
    const pkg = manifestOf(dir);
    for (const [dep, spec] of Object.entries(pkg.dependencies ?? {})) {
        if (!spec.startsWith("workspace:")) {
            continue;
        }
        if (!position.has(dep)) {
            problems.push(`${pkg.name} depends on ${dep}, which is not in PUB: it would publish an unresolvable specifier`);
        } else if (position.get(dep) > position.get(pkg.name)) {
            problems.push(`${dep} publishes after ${pkg.name}, which depends on it: reorder PUB`);
        }
    }
}

finish(
    [["The publish set (PUB in _tools/scripts/lib/packages.sh) is broken", problems]],
    [`publish set: ${dirs.length} packages, dependency-closed, topologically ordered`],
);
