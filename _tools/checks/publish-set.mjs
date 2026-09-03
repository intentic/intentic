#!/usr/bin/env node
/* THE PUBLISH SET IS CLOSED AND ORDERED, checked where breaking it costs milliseconds rather than a release.
 *
 * PUB in _tools/scripts/packages.sh is hand-maintained, and every package split re-litigates it by hand. The
 * failure it invites is quiet until publish day: a listed package depending on an unlisted workspace package
 * packs a version specifier nothing on npm satisfies, and the release either 403s mid-way (half-published, the
 * worst outcome) or ships a package nobody can install. Three gaps existed the day this was written.
 *
 * Order matters for the same reason closure does: publish-npm.sh publishes serially in PUB order so a
 * dependent never references a version npm cannot resolve yet.
 *
 * The list is read out of the shell file rather than handed in, so this runs from the manifest runner without
 * a bash in the path; release-prepare.sh still calls it with the array it sourced, and both readings have to
 * agree, which the `--` form below is for. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { root } from "./lib/repo.mjs";

// `PUB=( a b \ c )` in packages.sh: the array body, continuation backslashes folded, split on whitespace.
const pubFromScript = () => {
    const text = readFileSync(join(root, "_tools/scripts/packages.sh"), "utf8");
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
    console.error("publish set: could not read PUB out of _tools/scripts/packages.sh, the shape changed and this check needs updating");
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

finish([["The publish set (PUB in _tools/scripts/packages.sh) is broken", problems]], [
    `publish set: ${dirs.length} packages, dependency-closed, topologically ordered`,
]);
