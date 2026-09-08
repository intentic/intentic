#!/usr/bin/env node
// Checks that PUB (_tools/scripts/lib/packages.sh, hand-maintained) is dependency-closed and topologically ordered: an
// unlisted workspace dependency packs an unresolvable specifier, and publish-npm.sh publishes serially in PUB order.
// Reads the list out of the shell file so this runs without bash in the path.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { root } from "./lib/repo.mjs";

// The `PUB=( ... )` array body in packages.sh, continuation backslashes folded, split on whitespace.
const pubFromScript = () => {
    const text = readFileSync(join(root, "_tools/scripts/lib/packages.sh"), "utf8");
    const match = /^PUB=\(([\s\S]*?)\)/m.exec(text);
    if (match === null) {
        return undefined;
    }
    return match[1]
        .replaceAll("\\\n", " ")
        .split(/\s+/)
        .filter((entry) => entry !== "");
};

const given = process.argv.slice(2).filter((arg) => arg !== "--");
const dirs = given.length > 0 ? given : pubFromScript();
if (dirs === undefined) {
    console.error("publish set: could not read PUB out of _tools/scripts/lib/packages.sh, the shape changed and this check needs updating");
    process.exit(1);
}

const manifest = (dir) => JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
const position = new Map(dirs.map((dir, index) => [manifest(dir).name, index]));

const problems = [];
for (const dir of dirs) {
    const pkg = manifest(dir);
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

finish([["The publish set (PUB in _tools/scripts/lib/packages.sh) is broken", problems]], [
    `publish set: ${dirs.length} packages, dependency-closed, topologically ordered`,
]);
