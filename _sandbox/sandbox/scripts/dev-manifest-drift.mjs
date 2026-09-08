#!/usr/bin/env node
// Checks whether every baked package.json in a running sandbox still describes the dist dev-mounts.mjs binds over it;
// exits 0 if manifests agree, 1 if any drifted. Compares exports only, never dependencies, since a future pnpm prune
// could rewrite dependency fields and turn this into a permanent false failure.
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

// One `docker exec` batches every package; a never-baked package cats nothing and reports as absent.
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

// Splits back into one entry per package: delimiter line, then name line, then the file (possibly empty).
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
