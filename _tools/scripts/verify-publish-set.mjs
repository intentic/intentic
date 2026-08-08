#!/usr/bin/env node
/* The publish set must be CLOSED and ORDERED, checked where breaking it would hurt: before a release builds.
 *
 * PUB in packages.sh is hand-maintained, and every package split re-litigates it by hand. The failure it
 * invites is quiet until publish day: a listed package depending on an unlisted workspace package packs a
 * version specifier nothing on npm satisfies, and the release either 403s mid-way (half-published, the worst
 * outcome) or ships a package nobody can install. Three gaps existed the day this was written — the
 * extension-manifest split left the new package unlisted, and local-agent and sandbox-run had been unlisted
 * dependencies of listed packages all along, unnoticed because no release had shipped since they were added.
 *
 * Order matters for the same reason closure does: publish-npm.sh publishes serially in PUB order so a
 * dependent never references a version npm cannot resolve yet.
 *
 *   node _tools/scripts/verify-publish-set.mjs <dir> [<dir>…]   (release-prepare passes "${PUB[@]}")
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const dirs = process.argv.slice(2);
if (dirs.length === 0) {
    console.error("usage: verify-publish-set.mjs <package-dir>…");
    process.exit(2);
}

const manifest = (dir) => require(resolve(dir, "package.json"));
const position = new Map(dirs.map((dir, index) => [manifest(dir).name, index]));

const problems = [];
for (const dir of dirs) {
    const pkg = manifest(dir);
    for (const [dep, spec] of Object.entries(pkg.dependencies ?? {})) {
        if (!spec.startsWith("workspace:")) {
            continue;
        }
        if (!position.has(dep)) {
            problems.push(`${pkg.name} depends on ${dep}, which is not in PUB — it would publish an unresolvable specifier`);
        } else if (position.get(dep) > position.get(pkg.name)) {
            problems.push(`${dep} publishes after ${pkg.name}, which depends on it — reorder PUB`);
        }
    }
}

if (problems.length > 0) {
    console.error("publish set is broken:");
    for (const problem of problems) {
        console.error(`  - ${problem}`);
    }
    process.exit(1);
}
console.log(`publish set: ${dirs.length} packages, dependency-closed, topologically ordered`);
