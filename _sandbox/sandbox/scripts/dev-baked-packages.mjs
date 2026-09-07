// Which workspace packages the sandbox image bakes beside the daemon, and where each one's source lives.
//
// Shared by the two scripts that have to agree about that set: dev-mounts.mjs, which binds each package's
// compiled output over the baked copy, and dev-manifest-drift.mjs, which checks the baked manifest still
// describes what is being mounted. They disagreed once and the container ran a dist its own package.json
// refused to resolve, so the list has one definition.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

// Where the image puts the daemon, and where it puts the workspace packages pruned in beside it.
export const SANDBOX_ROOT = "/opt/sandbox";
export const packageDir = (name) => `${SANDBOX_ROOT}/node_modules/${name}`;

// Every workspace package in the repo, by its declared name: the mapping from `@intentic/sandbox-contract` to
// `_shared/sandbox-contract` is read, never assumed (`@intentic/lsp` lives in `_search/lsp`, not `_sandbox/lsp`).
// Groups are discovered, not listed: every `_`-prefixed root directory is a package group (pnpm-workspace.yaml).
export const workspacePackages = () => {
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
                // An unparseable manifest is not this module's problem: it just can't contribute a package.
            }
        }
    }
    return found;
};

// Which packages the image actually bakes beside the daemon. Read from the daemon's own dependency list rather
// than hardcoded, so a new workspace dependency becomes hot-reloadable without touching this file.
export const bakedPackageNames = () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "_sandbox/sandbox/package.json"), "utf8"));
    return Object.entries(manifest.dependencies ?? {})
        .filter(([, spec]) => typeof spec === "string" && spec.startsWith("workspace:"))
        .map(([name]) => name);
};
