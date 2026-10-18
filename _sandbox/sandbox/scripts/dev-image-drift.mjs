// Which third-party packages the checkout's daemon needs that a sandbox image was built without. The dists are mounted
// and node_modules never is, so this is the drift only an image build fixes. Compared over the daemon's production
// closure alone: the image's deploy lockfile (prepare-image-trees.sh's `pnpm deploy --prod` writes it into
// /opt/sandbox) against the checkout's importers, walked from the daemon through its workspace links. A version bump
// counts; a dependency some other workspace package added does not, so an unrelated install never costs a rebuild.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parseAllDocuments } from "yaml";

import { REPO_ROOT, SANDBOX_ROOT } from "./dev-baked-packages.mjs";

const DAEMON_IMPORTER = "_sandbox/sandbox";
export const IMAGE_LOCKFILE = `${SANDBOX_ROOT}/pnpm-lock.yaml`;

// `1.7.0(zod@4.6.5)` is `1.7.0` installed: the suffix records how its peers resolved, not another package.
const bare = (version) => version.split("(")[0];

// What `--prod` installs: dependencies and optional ones, never dev.
const runtimeDeps = (entry) => ({ ...entry?.dependencies, ...entry?.optionalDependencies });

const add = (closure, name, version) => {
    const versions = closure.get(name) ?? new Set();
    versions.add(version);
    closure.set(name, versions);
};

// name → versions, as the checkout's root lockfile resolves the daemon and every workspace package it links. Pure.
export const checkoutClosure = (lock) => {
    const closure = new Map();
    const seen = new Set();
    const walk = (importer) => {
        if (seen.has(importer)) {
            return;
        }
        seen.add(importer);
        for (const [name, { version }] of Object.entries(runtimeDeps(lock.importers?.[importer]))) {
            if (version.startsWith("link:")) {
                walk(posix.normalize(posix.join(importer, version.slice("link:".length))));
            } else {
                add(closure, name, bare(version));
            }
        }
    };
    walk(DAEMON_IMPORTER);
    return closure;
};

// The same, off a deploy lockfile: the daemon is its one importer, and each workspace package it carries is a
// `<name>@file:` snapshot holding that package's own dependencies. An importer names each as `{ specifier, version }`,
// a snapshot as the version alone. Pure.
export const imageClosure = (lock) => {
    const closure = new Map();
    const seen = new Set();
    const visit = (versions) => {
        for (const [name, version] of versions) {
            if (version.startsWith(`${name}@file:`)) {
                if (!seen.has(version)) {
                    seen.add(version);
                    visit(Object.entries(runtimeDeps(lock.snapshots?.[version])));
                }
            } else if (!version.startsWith("link:")) {
                add(closure, name, bare(version));
            }
        }
    };
    visit(Object.entries(runtimeDeps(lock.importers?.["."])).map(([name, { version }]) => [name, version]));
    return closure;
};

// Every package version the checkout's daemon resolves that the image does not hold, with the versions it holds of
// that name instead (empty when it has none). Sorted, so the same drift always reads the same. Pure.
export const missingFromImage = (checkoutLock, imageLock) => {
    const baked = imageClosure(imageLock);
    const missing = [];
    for (const [name, versions] of checkoutClosure(checkoutLock)) {
        for (const version of versions) {
            if (!baked.get(name)?.has(version)) {
                missing.push({ name, version, baked: [...(baked.get(name) ?? [])].sort() });
            }
        }
    }
    return missing.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
};

export const describeMissing = ({ name, version, baked }) =>
    baked.length === 0 ? `${name} ${version}` : `${name} ${baked.join(", ")} → ${version}`;

// pnpm 12 opens its lockfile with a document of its own (the package manager's pin, `packageManagerDependencies`)
// before the one describing the install; the install is the document with packages in it. Pure.
export const parseLock = (text) => {
    const documents = parseAllDocuments(text).map((document) => document.toJS() ?? {});
    return documents.findLast((document) => document.snapshots !== undefined) ?? documents.at(-1) ?? {};
};

export const readCheckoutLock = () => parseLock(readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8"));

// Read out of the running container; undefined when it cannot be (an image from before the deploy wrote one).
export const readImageLock = (container) => {
    try {
        const text = execFileSync("docker", ["exec", container, "cat", IMAGE_LOCKFILE], {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
        });
        return parseLock(text);
    } catch {
        return undefined;
    }
};
