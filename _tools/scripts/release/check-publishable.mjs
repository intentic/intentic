#!/usr/bin/env node
// Does npm know every name in the publish set? Asked while a release is still a PLAN, and again by publish-npm.sh
// before it packs anything.
//
// Trusted publishing is registered per package, on that package's own settings page — a name nobody has ever
// published has no such page, so no trusted publisher can be registered against it, so the release lane's OIDC
// exchange has nothing to exchange for (npm-publish.yml's header says the rest). The release lane therefore cannot
// publish a NEW name at all, and renaming a package is how a new name arrives without anyone deciding to add one:
// v1.249.0 renamed `@intentic/desktop` (53 versions, trusted publisher, provenance) to `@intentic/desktop-automation`
// as collateral of a directory reorganization, and the refusal landed after semantic-release had already tagged and
// released — a green release, a GitHub Release, and nothing on npm for any of the 28 packages.
//
// Which is why this is read at PLAN time: the release that cannot publish is the one that must not be cut.
//
// ONLY A DEFINITIVE 404 BLOCKS. A timeout, a socket error or a 5xx means the registry did not answer the question,
// and a registry having a bad minute is not a rename; the publish would fail loudly later anyway. Blocking a release
// on the registry's availability would trade one rare failure for a common one.
import { publishSet, manifestOf } from "../lib/packages.mjs";

const dirs = publishSet();
if (dirs === undefined) {
    console.error("publishable: could not read PUB out of _tools/scripts/lib/packages.sh, the shape changed and this guard needs updating");
    process.exit(1);
}

const REGISTRY = "https://registry.npmjs.org/";
// The workflow npm exchanges an OIDC token for, spelled the way `npm trust` wants it: filename only, no path.
const WORKFLOW = "npm-publish.yml";

// The abbreviated packument (`Accept:` below) is the smallest answer that still tells existence from absence, and the
// registry serves it from the same cache the installer hits. The status is all this reads; the body is dropped.
const known = async ({ name, registry }) => {
    const url = `${registry.replace(/\/?$/, "/")}${name.replace("/", "%2f")}`;
    try {
        const response = await fetch(url, {
            headers: { accept: "application/vnd.npm.install-v1+json" },
            signal: AbortSignal.timeout(15_000),
        });
        await response.body?.cancel();
        return response.status !== 404;
    } catch {
        // Unanswered, not absent: see the header.
        return true;
    }
};

const packages = dirs.map((dir) => {
    const pkg = manifestOf(dir);
    return { name: pkg.name, registry: pkg.publishConfig?.registry ?? REGISTRY, repository: pkg.repository?.url ?? "" };
});
const answers = await Promise.all(packages.map(known));
const missing = packages.filter((_, index) => !answers[index]);

if (missing.length > 0) {
    // The repository this release publishes from, as `npm trust` spells it: owner/repo out of the manifest's git URL.
    const slug = /github\.com[/:]([^/]+\/[^/.]+)/.exec(missing[0].repository)?.[1] ?? "<owner>/<repo>";
    console.error("the release lane cannot publish these — npm has never seen the name, so no trusted publisher can exist for it:");
    for (const { name } of missing) {
        console.error(`  ${name}`);
    }
    console.error("");
    console.error("a rename creates a new name: the published one keeps its trusted publisher and the new one has none.");
    console.error("either keep the published name, or bootstrap the new one once from an authenticated maintainer machine:");
    console.error("  bash _tools/scripts/release/publish-npm.sh <version> --interactive");
    for (const { name } of missing) {
        console.error(`  npm trust github ${name} --file ${WORKFLOW} --repo ${slug} --allow-publish`);
    }
    process.exit(1);
}

console.log(`publishable: npm knows all ${packages.length} names in the publish set`);
