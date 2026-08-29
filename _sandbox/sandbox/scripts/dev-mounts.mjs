#!/usr/bin/env node
// The dev bind-mounts that make a running sandbox read its compiled JavaScript from the working tree instead of
// from the image layer it was baked into.
//
// Prints one `hostPath:containerPath` per line for dev-sandbox.sh to turn into `-v` flags. Only paths that
// actually exist on the host are printed: a missing dist must fall back to the baked copy rather than mount an
// empty directory over a working daemon.
//
// Why this exists: the daemon is COPY'd into the image (Dockerfile: `COPY --from=trees sandbox /opt/sandbox`),
// so without these mounts the only way a running container can reflect a source edit is a full
// `pnpm build:sandbox`: turbo, six `pnpm deploy` prunes, and a docker build, minutes per edit. That latency is
// what made "did my change even land?" the most expensive question in the project. With them, a daemon edit is
// `tsgo` plus `docker restart`: seconds. See dev-reload.sh.
//
// Only compiled output is mounted, never node_modules: each baked package keeps the image's own installed
// dependencies (including its native builds: node-pty is rebuilt inside the image against its ABI, and a host
// copy would be wrong).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");

// Where the image puts the daemon, and where it puts the workspace packages pruned in beside it.
const SANDBOX_ROOT = "/opt/sandbox";
const packageDir = (name) => `${SANDBOX_ROOT}/node_modules/${name}`;

// Every workspace package in the repo, by its declared name: the mapping from `@intentic/sandbox-contract` to
// `_sandbox/sandbox-contract` is read, never assumed (`@intentic/lsp` lives in `_search/lsp`, not `_sandbox/lsp`).
// Groups are discovered, not listed: every `_`-prefixed root directory is a package group (pnpm-workspace.yaml).
const workspacePackages = () => {
    const found = new Map();
    const groups = readdirSync(REPO_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("_"))
        .map((entry) => entry.name);
    for (const group of groups) {
        const groupDir = join(REPO_ROOT, group);
        if (!existsSync(groupDir)) {
            continue;
        }
        for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const dir = join(groupDir, entry.name);
            const manifest = join(dir, "package.json");
            if (!existsSync(manifest)) {
                continue;
            }
            try {
                const { name } = JSON.parse(readFileSync(manifest, "utf8"));
                if (typeof name === "string") {
                    found.set(name, dir);
                }
            } catch {
                // An unparseable manifest is not this script's problem: it just can't contribute a mount.
            }
        }
    }
    return found;
};

// Which packages the image actually bakes beside the daemon. Read from the daemon's own dependency list rather
// than hardcoded, so a new workspace dependency becomes hot-reloadable without touching this file.
const bakedPackageNames = () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "_sandbox/sandbox/package.json"), "utf8"));
    return Object.entries(manifest.dependencies ?? {})
        .filter(([, spec]) => typeof spec === "string" && spec.startsWith("workspace:"))
        .map(([name]) => name);
};

const mounts = [];
const push = (hostPath, containerPath) => {
    if (existsSync(hostPath)) {
        mounts.push(`${hostPath}:${containerPath}`);
    }
};

// The daemon's own compiled output.
push(join(REPO_ROOT, "_sandbox/sandbox/dist"), `${SANDBOX_ROOT}/dist`);

// Each baked workspace package's compiled output, mounted over the pruned copy in the daemon's node_modules.
const packages = workspacePackages();
for (const name of bakedPackageNames()) {
    const dir = packages.get(name);
    if (dir !== undefined) {
        push(join(dir, "dist"), `${packageDir(name)}/dist`);
    }
}

process.stdout.write(mounts.join("\n") + (mounts.length > 0 ? "\n" : ""));
