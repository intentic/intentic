import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { undefinedIfMissing } from "@intentic/base/errors";

// The published version behind `ghcr.io/intentic/sandbox:stable`, set by the release flow before the image builds.
export const { version } = createRequire(import.meta.url)(join(packageRoot(import.meta.url), "package.json")) as { version: string };

// When this daemon started, as /info's `running` reports it: a container swapped in is a new boot, which is how a page
// tells a swap landed where the build cannot (a checkout build reads 0.0.0 and the same base before and after).
export const bootedAt = Date.now();

// True only for the repo's unpublished 0.0.0 sentinel version; every non-release build (local, CI sha/latest) keeps it.
export const isDevBuild = version === "0.0.0";

// Newest mtime under `dir`, in epoch ms, walked recursively; anything unreadable contributes nothing rather than
// throwing.
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
        } catch (error) {
            // A file that vanished mid-walk is not part of the build.
            undefinedIfMissing(error);
        }
    }
    return newest;
};

// Sent on the /events hello frame so the browser drops what it cached from a different build. Version alone can't
// distinguish working-tree builds (all 0.0.0), so identity adds the newest mtime under the compiled tree, computed
// once.
let identity: string | undefined;
export const buildId = (): string => {
    identity ??= `${version}:${newestMtimeMs(import.meta.dirname)}`;
    return identity;
};
