// Which workspace packages the sandbox image bakes beside the daemon, and where each lives. Single source of truth
// shared by dev-mounts.mjs (binds compiled output over the baked copy) and dev-manifest-drift.mjs (checks the baked
// manifest matches).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";

export const REPO_ROOT = repoRoot(import.meta.url);

// Where the image installs the daemon and the workspace packages baked in beside it.
export const SANDBOX_ROOT = "/opt/sandbox";
export const packageDir = (name) => `${SANDBOX_ROOT}/node_modules/${name}`;

// Maps every workspace package's declared name to its directory, read from package.json rather than assumed (e.g.
// `@intentic/lsp` lives in `_search/lsp`). Package groups are discovered: every `_`-prefixed root directory is one.
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
                // An unparseable manifest just can't contribute a package.
            }
        }
    }
    return found;
};

// Packages the image bakes beside the daemon, read from the daemon's own `workspace:` dependencies rather than
// hardcoded here.
export const bakedPackageNames = () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "_sandbox/sandbox/package.json"), "utf8"));
    return Object.entries(manifest.dependencies ?? {})
        .filter(([, spec]) => typeof spec === "string" && spec.startsWith("workspace:"))
        .map(([name]) => name);
};
