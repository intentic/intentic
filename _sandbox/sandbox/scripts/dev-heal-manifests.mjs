#!/usr/bin/env node
// Runs INSIDE a dev sandbox, from the checkout dev-mounts.mjs binds at /opt/sandbox/dev-checkout, before the daemon
// starts (docker-entrypoint.sh) and before dev-restart.sh's load check. Only dists are mounted over the image's baked
// packages, so a manifest the checkout changed since the image was built goes unseen: a new export subpath (2026-10-18,
// `@intentic/base/image-fit`) or a whole new workspace package (2026-10-17, `@intentic/speech`) crashed the daemon on
// its next start, which after a sleep is any wake. This lays the checkout's manifests over the baked ones instead.
// A dependency the image never installed is not fixable here; dev-before-sleep.mjs rebuilds for that.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bakedPackageNames, packageDir, SANDBOX_ROOT, workspacePackages } from "./dev-baked-packages.mjs";

// The fields Node resolves a package by. Everything else in a baked manifest is left as the deploy wrote it.
const RESOLUTION_FIELDS = ["type", "main", "exports", "imports"];
// Left in a package this script laid in whole, so the next start refreshes its copied dist instead of keeping it.
const LAID_IN = ".intentic-dev-laid-in";
// pnpm's hoisted view of every package the deploy installed, where a laid-in package finds its dependencies.
const HOISTED = `${SANDBOX_ROOT}/node_modules/.pnpm/node_modules`;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const exportKeys = (manifest) => Object.keys(manifest.exports ?? {});

// The baked manifest with the source's resolution fields laid over it. Pure.
const healedManifest = (baked, source) => {
    const healed = { ...baked };
    for (const field of RESOLUTION_FIELDS) {
        if (field in source) {
            healed[field] = source[field];
        } else {
            delete healed[field];
        }
    }
    return healed;
};

// What changed, in the words the log line uses. Pure.
const exportChange = (baked, source) => {
    const before = new Set(exportKeys(baked));
    const after = new Set(exportKeys(source));
    const parts = [];
    const gained = [...after].filter((key) => !before.has(key));
    const lost = [...before].filter((key) => !after.has(key));
    if (gained.length > 0) {
        parts.push(`gained ${gained.join(", ")}`);
    }
    if (lost.length > 0) {
        parts.push(`dropped ${lost.join(", ")}`);
    }
    return parts.length > 0 ? parts.join("; ") : "changed how it resolves";
};

// A bind mount is another filesystem than the directory it sits in; a dist copied here is the same one.
const mountedOver = (dir, child) => existsSync(child) && statSync(child).dev !== statSync(dir).dev;

const layIn = (name, sourceDir, target) => {
    mkdirSync(target, { recursive: true, mode: 0o755 });
    writeFileSync(join(target, "package.json"), readFileSync(join(sourceDir, "package.json")), { mode: 0o644 });
    // A dist mount that came with the container (dev-mounts.mjs saw the package) is the live one, and never chmodded:
    // its files are the checkout's. Otherwise the copy is as fresh as a mount would be for a daemon that reads it once.
    const dist = join(target, "dist");
    if (!mountedOver(target, dist) && existsSync(join(sourceDir, "dist"))) {
        rmSync(dist, { recursive: true, force: true });
        cpSync(join(sourceDir, "dist"), dist, { recursive: true });
        // Host files are often 0600; the daemon and the tools it starts read these as whoever they run as.
        execFileSync("chmod", ["-R", "go=rX", dist]);
    }
    if (!existsSync(join(target, "node_modules"))) {
        symlinkSync(HOISTED, join(target, "node_modules"));
    }
    writeFileSync(join(target, LAID_IN), "", { mode: 0o644 });
    console.log(`intentic: dev checkout: laid in ${name}, which the image was built without`);
};

const heal = () => {
    const packages = workspacePackages();
    for (const name of bakedPackageNames()) {
        const sourceDir = packages.get(name);
        if (sourceDir === undefined) {
            continue;
        }
        const target = packageDir(name);
        const bakedPath = join(target, "package.json");
        if (!existsSync(bakedPath) || existsSync(join(target, LAID_IN))) {
            layIn(name, sourceDir, target);
            continue;
        }
        const source = readJson(join(sourceDir, "package.json"));
        const baked = readJson(bakedPath);
        const healed = healedManifest(baked, source);
        if (JSON.stringify(healed) !== JSON.stringify(baked)) {
            // In place, so the file keeps the mode the image gave it.
            writeFileSync(bakedPath, `${JSON.stringify(healed, null, 4)}\n`);
            console.log(`intentic: dev checkout: ${name}'s manifest ${exportChange(baked, source)} since the image was built`);
        }
    }
};

heal();
