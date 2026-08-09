import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageRoot } from "@intentic/constants/node";

// The release flow bumps package versions before building the stable image, so this is the readable version
// behind ghcr.io/intentic/sandbox:stable.
export const { version } = createRequire(import.meta.url)(join(packageRoot(import.meta.url), "package.json")) as { version: string };

// Only semantic-release's prepareCmd stamps a real version into package.json; everything built from a working
// tree (local `pnpm dev`, the CI sha-/latest images) keeps the repo's unpublished 0.0.0 sentinel. That sentinel
// is the daemon's "I am not a release" signal: its @intentic/* packages aren't on npm (see ensure-intent's
// dependencySpec) and it has no release version to compare against (see platform/version-check.ts).
export const isDevBuild = version === "0.0.0";

// The newest mtime anywhere under `dir`, in epoch ms. Directories are walked; anything unreadable contributes
// nothing (a permission or race failure must never turn the build identity into a throw on the hello path).
const newestMtimeMs = (dir: string): number => {
    let newest = 0;
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return newest;
    }
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            newest = Math.max(newest, newestMtimeMs(path));
            continue;
        }
        try {
            newest = Math.max(newest, statSync(path).mtimeMs);
        } catch {
            // a file that vanished mid-walk — it cannot be part of the build we are identifying
        }
    }
    return newest;
};

/* WHICH BUILD OF THE DAEMON THIS IS — advertised on the /events hello frame so the browser can drop what it
 * cached from a DIFFERENT one.
 *
 * The browser persists daemon responses to IndexedDB and paints them stale-while-revalidate on the next load.
 * That is right across restarts of the same daemon and wrong across a rebuild: the payload shapes are the
 * daemon's to change, and hydrating an old build's answers into a new build's components is how a
 * `pnpm build:sandbox && dev-sandbox.sh` swap left a workspace that only a site-data wipe would fix.
 *
 * `version` alone cannot say it — every working-tree build carries the same 0.0.0 sentinel — so the identity
 * is version + the newest mtime across the daemon's own compiled tree. In an image that is the layer's build
 * time: stable across restarts, different after an update. Under the dev bind mounts it is the last `tsgo`,
 * which is exactly the granularity a developer changing response shapes needs. Computed once, lazily: one
 * directory walk of a few hundred files, off the request path after the first hello. */
let identity: string | undefined;
export const buildId = (): string => {
    identity ??= `${version}:${newestMtimeMs(dirname(fileURLToPath(import.meta.url)))}`;
    return identity;
};
