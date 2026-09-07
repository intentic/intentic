#!/usr/bin/env node
// Does every baked package.json in a running sandbox still describe the dist dev-mounts.mjs binds over it?
//
//   node _sandbox/sandbox/scripts/dev-manifest-drift.mjs <container>
//
// Exits 0 when the manifests agree, 1 when any has drifted (and says which subpaths, and what to run).
//
// Why this check exists: only compiled output is mounted, never node_modules (dev-mounts.mjs explains why), so
// a package.json is installed by an image build and by nothing else. Add an export subpath to a baked package,
// reload fast, and the container ends up with the new dist/ and the OLD manifest — Node then refuses the
// subpath that is sitting right there on disk, with `Package subpath './x' is not defined by "exports"`. That
// shipped: `@intentic/base` gained ./format and ./plain-text, and `iq` (whose engine imports ./format at module
// top level) died at startup on every invocation, along with the daemon's rule and CI paths that import
// ./plain-text. dev-sandbox.mjs's watcher already forces a full rebuild on a manifest edit, so this is the guard
// for the fast path invoked directly, where nothing was watching.
//
// Exports only, deliberately. `pnpm deploy` copies these manifests verbatim (all 22 baked ones are byte-identical
// to their source), but the field it would be most tempting to also compare — dependencies — is the one a future
// pnpm could start rewriting during the prune, which would turn this guard into a permanent false failure that
// blocks every reload. A missing dependency also announces itself as ERR_MODULE_NOT_FOUND naming the package,
// whereas an unresolvable subpath points at a file that is visibly present.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bakedPackageNames, packageDir, SANDBOX_ROOT, workspacePackages } from "./dev-baked-packages.mjs";

const container = process.argv[2];
if (!container) {
    console.error("usage: dev-manifest-drift.mjs <container>");
    process.exit(2);
}

const packages = workspacePackages();
const names = bakedPackageNames().filter((name) => packages.has(name));

// One `docker exec` for all of them rather than one apiece: the check sits in front of every fast reload, and
// twenty-odd container round trips is latency the loop exists to avoid. A package the image never baked cats
// nothing and is reported as absent, which is its own reason to rebuild.
const DELIM = "@@INTENTIC-MANIFEST@@";
const script = names
    .map((name) => `printf '%s\\n%s\\n' '${DELIM}' '${name}'; cat '${packageDir(name)}/package.json' 2>/dev/null || true`)
    .join("; ");

let raw;
try {
    raw = execFileSync("docker", ["exec", container, "sh", "-c", script], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
} catch (error) {
    console.error(`error: could not read the baked manifests out of ${container}: ${error.message}`);
    process.exit(2);
}

// Split back into one entry per package: the delimiter line, then the name line, then the file (possibly empty).
const bakedManifests = new Map();
for (const chunk of raw.split(`${DELIM  }\n`)) {
    if (chunk.trim() === "") {
        continue;
    }
    const cut = chunk.indexOf("\n");
    const name = chunk.slice(0, cut).trim();
    const body = chunk.slice(cut + 1).trim();
    bakedManifests.set(name, body);
}

const exportKeys = (manifest) => Object.keys(manifest?.exports ?? {}).sort();

const drifted = [];
for (const name of names) {
    const source = JSON.parse(readFileSync(join(packages.get(name), "package.json"), "utf8"));
    const body = bakedManifests.get(name);
    if (body === undefined || body === "") {
        drifted.push({ name, absent: true, missing: [], extra: [] });
        continue;
    }
    let bakedManifest;
    try {
        bakedManifest = JSON.parse(body);
    } catch {
        drifted.push({ name, absent: true, missing: [], extra: [] });
        continue;
    }
    const want = exportKeys(source);
    const have = exportKeys(bakedManifest);
    const missing = want.filter((key) => !have.includes(key));
    const extra = have.filter((key) => !want.includes(key));
    if (missing.length > 0 || extra.length > 0) {
        drifted.push({ name, absent: false, missing, extra });
    }
}

if (drifted.length === 0) {
    process.exit(0);
}

console.error(`error: ${container} was built before the current package manifests, so a restart would run code it cannot resolve.`);
for (const { name, absent, missing, extra } of drifted) {
    if (absent) {
        console.error(`       ${name}: not baked into the image at ${SANDBOX_ROOT}/node_modules/${name}`);
        continue;
    }
    const parts = [];
    if (missing.length > 0) {
        parts.push(`missing ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
        parts.push(`stale ${extra.join(", ")}`);
    }
    console.error(`       ${name}: baked exports ${parts.join("; ")}`);
}
console.error("       node_modules is never mounted, so only an image build installs a manifest: run 'pnpm rebuild:sandbox'.");
process.exit(1);
