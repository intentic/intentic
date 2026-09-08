#!/usr/bin/env node
// The lockfile still records the manifests: importer specifiers, the catalog snapshot, the pinned pnpm version, and
// reachability of every locked package, with nothing the manifests no longer reach.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { idOf, readCatalogs, readLockfile, readPackageManagerPin } from "./lib/lockfile.mjs";
import { finish } from "./lib/report.mjs";
import { packages, root, trackedFiles } from "./lib/repo.mjs";

const { recorded, installed, catalogued, edges } = readLockfile();
const catalogs = readCatalogs();
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Flattens a manifest to `name -> { specifier, required }`, compared against the union of the importer's blocks (pnpm
// decides which block a dependency lands in). A peerDependency is permitted, not required: pnpm installs one only when
// nothing else satisfies it.
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

// Whether the lockfile's recorded specifier could have come from the declared one, including via a catalog.
const matches = (name, declared, inLockfile) => {
    if (inLockfile === declared) {
        return true;
    }
    if (!declared.startsWith("catalog:")) {
        return false;
    }
    return catalogs.get(declared.slice("catalog:".length) || "default")?.get(name) === inLockfile;
};

// Every importer pnpm would write, plus the root, which the package walk doesn't reach.
const importers = [{ at: ".", dir: root }, ...packages.map(({ name, dir }) => ({ at: name, dir }))];

const importerDrift = (importer, dir) => {
    const declared = declaredBy(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")));
    const blocks = recorded.get(importer);
    if (blocks === undefined) {
        // A package that installs nothing gets no importer entry at all.
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

// The pin in `packageManagerDependencies:` must name and match package.json's `packageManager`: pnpm rewrites this
// block on every command, not just install, so a wrong entry keeps re-appearing after being fixed.
{
    const pin = /^(.+)@([^@]+)$/.exec(rootManifest.packageManager?.split("+")[0] ?? "");
    if (pin === null) {
        drift.push(`package.json has no readable "packageManager" pin, so the lockfile's recorded package manager cannot be checked`);
    } else {
        const [, manager, version] = pin;
        const pinned = readPackageManagerPin();
        for (const [name, recordedVersion] of pinned) {
            if (name !== manager) {
                drift.push(`pnpm-lock.yaml pins ${name}@${recordedVersion} as a package manager, but package.json names ${manager}@${version} and nothing else`);
            } else if (recordedVersion !== version) {
                drift.push(`pnpm-lock.yaml pins ${name}@${recordedVersion}, package.json pins ${manager}@${version}`);
            }
        }
        if (!pinned.has(manager)) {
            drift.push(`pnpm-lock.yaml records no ${manager} in "packageManagerDependencies:", the pin package.json declares`);
        }
    }
}

// Every tracked file pinning a pnpm to run — another `packageManager` field, a `corepack prepare` — must match the root
// pin; found by structural discovery, not a list, so a new environment needs no edit here.
{
    const pin = rootManifest.packageManager;
    const version = (spec) => spec.split("+")[0];
    const elsewhere = [];
    for (const path of trackedFiles()) {
        const name = basename(path);
        if (name === "package.json") {
            if (path === "package.json") {
                continue; // the pin itself
            }
            try {
                const declared = JSON.parse(readFileSync(join(root, path), "utf8")).packageManager;
                if (declared !== undefined) {
                    elsewhere.push([path, declared]);
                }
            } catch {
                // Unreadable or not JSON: the manifest checks above are what answer for that.
            }
        } else if (name.startsWith("Dockerfile")) {
            for (const [, prepared] of readFileSync(join(root, path), "utf8").matchAll(/corepack\s+prepare\s+(\S+)/g)) {
                elsewhere.push([path, prepared]);
            }
        }
    }
    for (const [path, declared] of elsewhere) {
        if (version(declared) !== version(pin)) {
            drift.push(`${path} installs ${declared}, package.json pins ${pin}: a checkout run by two pnpm versions rewrites the lockfile under itself`);
        }
    }
}

// Compares catalogs only where both copies speak: a catalog may snapshot only entries something has resolved through,
// so being absent from the lockfile is not drift — a different value is.
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
// An id reached but absent from `snapshots:` means this check misread the lockfile; every orphan reported after it is
// then suspect too.
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
        `lockfile: ${importers.length} importers record the specifiers their package.json declares, ` +
            `${catalogued.values().reduce((all, entries) => all + entries.size, 0)} catalogued versions are the ones pnpm-workspace.yaml names, ` +
            `and the recorded package manager is ${rootManifest.packageManager}, which is what every environment that pins one installs`,
        `lockfile reachability: all ${edges.size} packages in the lockfile are depended on by something`,
    ],
);
