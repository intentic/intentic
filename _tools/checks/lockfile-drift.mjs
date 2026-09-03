#!/usr/bin/env node
/* THE LOCKFILE STILL RECORDS THE MANIFESTS, and carries nothing the manifests no longer reach.
 *
 * DRIFT. `pnpm install --frozen-lockfile` is the first line of every CI job, and ERR_PNPM_OUTDATED_LOCKFILE is
 * what it says when someone edited a package.json without installing. That is a pure comparison between two
 * files in the checkout, and CI reaches it only after resolving 1,800+ packages against the registry: 0.6-1.5
 * min, paid by four jobs in parallel, to report a mismatch that needs no network to see. `verifyDepsBeforeRun:
 * false` (pnpm-workspace.yaml) is what makes it reachable at all: with the pre-run deps check off, nothing else
 * in a worktree ever says the manifest and the lockfile disagree.
 *
 * The CATALOG half is the same comparison against the lockfile's other copy of the manifest, added after the
 * first half let a bump through: an importer may record a `catalog:` specifier verbatim, in which case matching
 * it against the manifest compares `"catalog:"` to `"catalog:"` and passes for every version the catalog could
 * name. So `pnpm-workspace.yaml` moved to a new SDK, the lockfile stayed on the old one, the importer check
 * said 92 importers agreed, and the install that reconciled node_modules landed in the middle of the test run
 * it was supposed to precede.
 *
 * REACHABILITY. pnpm rewrites `importers:` on every install and prunes the two regions below it only when it
 * RESOLVES. A `--frozen-lockfile` install compares importers against the manifests and touches nothing else;
 * so does `--lockfile-only`, and so does `--force`. Delete a package from the workspace, commit the lockfile the
 * shortcut hands back, and its whole subtree stays in the file: installed, and still owed a decision in
 * `allowBuilds` for any build script inside it. That is what took five jobs down at once: removing the VSCode
 * extension dropped `@vscode/vsce-sign` from `allowBuilds` while `ovsx -> @vscode/vsce -> @vscode/vsce-sign`
 * stayed in the lockfile, and every job died on ERR_PNPM_IGNORED_BUILDS in `pnpm install`. Reachability, not
 * a name match, because the subtree is the point: 169 entries went dead behind those three, and only the
 * graph knows which. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { idOf, readCatalogs, readLockfile } from "./lib/lockfile.mjs";
import { finish } from "./lib/report.mjs";
import { packages, root } from "./lib/repo.mjs";

const { recorded, installed, catalogued, edges } = readLockfile();
const catalogs = readCatalogs();

/* What a package.json declares, flattened to `name -> { specifier, required }`.
 *
 * Compared as one set against the union of the importer's blocks rather than block by block, because which
 * block an entry lands in is pnpm's business and not a fact about the manifest: `autoInstallPeers: true`
 * installs peerDependencies and files them under the importer's `dependencies`. A peer is PERMITTED rather
 * than required for the same reason from the other side: pnpm installs one only when nothing else already
 * satisfies it, so its absence from the lockfile says nothing, while a mismatch still does. And it never
 * SHADOWS a real declaration: a package that declares the same name both ways is recorded by the real one. */
const declaredBy = (manifest) => {
    const declared = new Map(
        ["dependencies", "devDependencies", "optionalDependencies"].flatMap((field) =>
            Object.entries(manifest[field] ?? {}).map(([name, specifier]) => [name, { specifier, required: true }]),
        ),
    );
    for (const [name, specifier] of Object.entries(manifest.peerDependencies ?? {})) {
        if (!declared.has(name)) {
            declared.set(name, { specifier, required: false });
        }
    }
    return declared;
};

// Whether the lockfile's recorded specifier is one the declared specifier is allowed to have produced.
const matches = (name, declared, inLockfile) => {
    if (inLockfile === declared) {
        return true;
    }
    if (!declared.startsWith("catalog:")) {
        return false;
    }
    return catalogs.get(declared.slice("catalog:".length) || "default")?.get(name) === inLockfile;
};

// Every importer pnpm would write, by the same walk the other checks use, plus the root the walk does not reach.
const importers = [{ at: ".", dir: root }, ...packages.map(({ name, dir }) => ({ at: name, dir }))];

const importerDrift = (importer, dir) => {
    const declared = declaredBy(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")));
    const blocks = recorded.get(importer);
    if (blocks === undefined) {
        // A package that installs nothing gets no importer: there is nothing for pnpm to have recorded.
        return declared.size > 0 ? [`${importer}: declares dependencies but has no importer in the lockfile, it has never been installed`] : [];
    }
    const found = [];
    const inLockfile = new Map(blocks.values().flatMap((fromBlock) => fromBlock.entries()));
    for (const [name, { specifier, required }] of declared) {
        const was = inLockfile.get(name);
        if (was === undefined) {
            if (required) {
                found.push(`${importer}: ${name}@${specifier} is not in the lockfile`);
            }
        } else if (!matches(name, specifier, was)) {
            found.push(`${importer}: ${name} is ${specifier}, the lockfile records ${was}`);
        }
    }
    for (const name of inLockfile.keys()) {
        if (!declared.has(name)) {
            found.push(`${importer}: ${name} is in the lockfile but no longer in package.json`);
        }
    }
    return found;
};

const drift = [];
if (recorded.size === 0) {
    drift.push(`pnpm-lock.yaml has no readable "importers:" region: the lockfile format moved and this check needs rewriting`);
}
for (const { at: importer, dir } of recorded.size === 0 ? [] : importers) {
    drift.push(...importerDrift(importer, dir));
}
for (const importer of recorded.keys()) {
    if (!importers.some(({ at: known }) => known === importer)) {
        drift.push(`${importer}: an importer in the lockfile with no package.json, the package was removed without installing`);
    }
}

/* The catalogs, compared where both copies speak: an entry the lockfile snapshotted has to still say what
 * pnpm-workspace.yaml says, and has to still be in pnpm-workspace.yaml at all. Only where both speak, because
 * the two are not the same set: pnpm records an entry once some importer resolves through it, so a catalog may
 * hold versions nothing has claimed yet (reached through `overrides` rather than a `catalog:` specifier).
 * Absent-from-the-lockfile is therefore silent; DIFFERENT is the whole signal. */
for (const [name, entries] of catalogs) {
    const snapshot = catalogued.get(name);
    if (snapshot === undefined) {
        continue;
    }
    for (const [dependency, specifier] of entries) {
        const was = snapshot.get(dependency);
        if (was !== undefined && was !== specifier) {
            drift.push(`catalog ${name}: ${dependency} is ${specifier}, the lockfile records ${was}`);
        }
    }
    for (const dependency of snapshot.keys()) {
        if (!entries.has(dependency)) {
            drift.push(`catalog ${name}: ${dependency} is in the lockfile but no longer in pnpm-workspace.yaml`);
        }
    }
}
for (const name of catalogued.keys()) {
    if (!catalogs.has(name)) {
        drift.push(`catalog ${name}: a catalog in the lockfile that pnpm-workspace.yaml no longer declares`);
    }
}

/* Reachability: roots are the `version:` lines the importers resolved, edges are the snapshots' own. */
const reached = new Set();
for (const pending = installed.map(([name, version]) => idOf(name, version)).filter(Boolean); pending.length > 0; ) {
    const id = pending.pop();
    if (reached.has(id)) {
        continue;
    }
    reached.add(id);
    pending.push(...(edges.get(id) ?? []).filter((to) => !reached.has(to)));
}

const stranded = [];
if (edges.size === 0) {
    stranded.push(`pnpm-lock.yaml has no readable "snapshots:" region: the lockfile format moved and this check needs rewriting`);
}
// An id reached but absent from `snapshots:` means the walk read an edge it should not have, and every orphan
// this run reports is then suspect. Said as its own line rather than folded in, because the fix is different.
for (const id of reached) {
    if (!edges.has(id)) {
        stranded.push(`${id} is depended on by something in "snapshots:" but has no entry of its own: this check misread the lockfile`);
    }
}
if (stranded.length === 0) {
    for (const id of edges.keys()) {
        if (!reached.has(id)) {
            stranded.push(id);
        }
    }
}

finish(
    [
        ["pnpm-lock.yaml is out of date: run `pnpm install` and commit it (this is CI's ERR_PNPM_OUTDATED_LOCKFILE)", drift],
        [
            "pnpm-lock.yaml still carries packages nothing depends on: run `pnpm install` (a real resolution prunes them) and " +
                "commit it. They are installed on every runner, and each build script inside them is one CI demands a decision " +
                "for in `allowBuilds`",
            stranded,
        ],
    ],
    [
        `lockfile: ${importers.length} importers record the specifiers their package.json declares, and ` +
            `${catalogued.values().reduce((all, entries) => all + entries.size, 0)} catalogued versions are the ones pnpm-workspace.yaml names`,
        `lockfile reachability: all ${edges.size} packages in the lockfile are depended on by something`,
    ],
);
