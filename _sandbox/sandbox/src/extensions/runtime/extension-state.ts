import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMissing } from "@intentic/base/errors";
import { pathExists } from "@intentic/base/fs";
import { type ExtensionManifest, extensionIdOf } from "@intentic/extension-manifest";
import { extensionCacheDir, extensionStateDir, legacyExtensionStateDir } from "@intentic/sandbox-contract";

// The two directories an extension's own code keeps things in, `api.stateDir` and `api.cacheDir`: keyed by its identity
// (`publisher.name`) like its settings and its switch, so they survive an update, a re-install and dev mode, and go only
// when the identity does (extension-removal.ts). Created here before any of its code runs, the backend host's and its
// processes' alike, so neither half races the other to make them.

export interface ExtensionDirs {
    readonly stateDir: string;
    readonly cacheDir: string;
}

export const extensionDirsOf = (root: string, manifest: Pick<ExtensionManifest, "publisher" | "name">): ExtensionDirs => {
    const identity = extensionIdOf(manifest);
    return { stateDir: join(root, extensionStateDir(identity)), cacheDir: join(root, extensionCacheDir(identity)) };
};

// The publisher whose extensions kept their state under their bare name before the directory was keyed by identity.
// Nobody else's ever did, since only first-party code was written against the old helper.
const FIRST_PARTY = "intentic";

// The control address a gateway published inside its directory before it had a place of its own (extensionGatewayUrlFile):
// stale once moved, and rewritten where it now lives the moment the gateway starts.
const LEGACY_GATEWAY_URL = "gateway.url";

// Moves a first-party extension's directory from its bare name to its identity, once: only when the old one is there
// and the new one is not, so a later run never merges or overwrites anything. A move another caller already made
// (the backend host and a process preparing at once) reads as done.
const adoptLegacyState = async (root: string, name: string, stateDir: string): Promise<void> => {
    const legacy = join(root, legacyExtensionStateDir(name));
    if (legacy === stateDir || !(await pathExists(legacy)) || (await pathExists(stateDir))) {
        return;
    }
    await mkdir(dirname(stateDir), { recursive: true });
    try {
        await rename(legacy, stateDir);
    } catch (error) {
        if (isMissing(error)) {
            return;
        }
        throw error;
    }
    await rm(join(stateDir, LEGACY_GATEWAY_URL), { force: true });
};

export const prepareExtensionDirs = async (root: string, manifest: Pick<ExtensionManifest, "publisher" | "name">): Promise<ExtensionDirs> => {
    const dirs = extensionDirsOf(root, manifest);
    if (manifest.publisher === FIRST_PARTY) {
        await adoptLegacyState(root, manifest.name, dirs.stateDir);
    }
    await Promise.all([mkdir(dirs.stateDir, { recursive: true }), mkdir(dirs.cacheDir, { recursive: true })]);
    return dirs;
};

// The ones that exist, for the removal plan, undefined for one the extension never made: nothing to warn about.
export const existingExtensionDirs = async (
    root: string,
    manifest: Pick<ExtensionManifest, "publisher" | "name">,
): Promise<{ readonly stateDir: string | undefined; readonly cacheDir: string | undefined }> => {
    const dirs = extensionDirsOf(root, manifest);
    const [state, cache] = await Promise.all([pathExists(dirs.stateDir), pathExists(dirs.cacheDir)]);
    return { stateDir: state ? dirs.stateDir : undefined, cacheDir: cache ? dirs.cacheDir : undefined };
};

export const forgetExtensionDirs = async (root: string, manifest: Pick<ExtensionManifest, "publisher" | "name">): Promise<void> => {
    const dirs = extensionDirsOf(root, manifest);
    await Promise.all([rm(dirs.stateDir, { recursive: true, force: true }), rm(dirs.cacheDir, { recursive: true, force: true })]);
};
