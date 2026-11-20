import { existsSync } from "node:fs";
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { renameOver } from "@intentic/base/fs";
import { repoRoot } from "@intentic/constants/node";
import { DEV_VERSION } from "@intentic/sandbox-contract/state/versions";
import { binDir } from "../../config.js";
import { archToken, downloadAsset, exe, osToken, releaseAssetUrl, vacate, versionOf } from "../../release.js";
import { verifyReleaseFiles } from "../../release/release-verify.js";

/* WHICH intentic-remoted THIS AGENT STARTS (2026-11-20). The daemon serving people's remote desktop and terminals is a
   binary of its own beside the agent, in bin/, from the agent's own release and checked against that release's signed
   SHA256SUMS as the launcher, the keyring and ic are (release/release-verify.ts). It is fetched when it is first needed
   (a remoteStart finding none) and again whenever the one in bin/ answers another version than this agent's. A
   from-source agent never downloads: it takes the remoted built in its own checkout. INTENTIC_REMOTED_BIN overrides
   every build, which is how the tests stand a fake in. */

export const REMOTED_BIN_ENV = "INTENTIC_REMOTED_BIN";

const remotedPath = join(binDir, `intentic-remoted${exe}`);

// The platforms a release publishes remoted for, as its asset names spell them.
const PUBLISHED: ReadonlySet<string> = new Set(["windows-amd64", "linux-amd64", "linux-arm64"]);

// Whether a release carries a remoted for this platform and CPU, from Node's own names for them. Pure.
export const remotedPublishedFor = (platform: NodeJS.Platform, arch: string): boolean => {
    const os = platform === "win32" ? "windows" : platform;
    const cpu = arch === "x64" ? "amd64" : arch;
    return PUBLISHED.has(`${os}-${cpu}`);
};

const remotedAssetName = (): string => `intentic-remoted-${osToken()}-${archToken()}${exe}`;

// Where a remoted could come from here at all, which is when the agent advertises `remote`: an override, one already in
// bin/, or a release built for this platform. Pure over what it is handed.
export const remotedCanExist = (env: NodeJS.ProcessEnv, inBin: boolean, platform: NodeJS.Platform, arch: string): boolean =>
    (env[REMOTED_BIN_ENV] ?? "") !== "" || inBin || remotedPublishedFor(platform, arch);

export const remotedAdvertised = (): boolean => remotedCanExist(process.env, existsSync(remotedPath), process.platform, process.arch);

// A remoted that cannot be had, and why, in a sentence the sandbox shows the person who asked.
export class RemotedUnavailable extends Error {}

// The remoted built in this agent's own checkout, for a from-source agent; never one on PATH.
const localRemotedBuild = (from: string = import.meta.url): string | undefined => {
    let root: string;
    try {
        root = repoRoot(from);
    } catch {
        // allow(silent-catch): a compiled agent has no checkout around it, so there is no local build to find
        return undefined;
    }
    const candidate = join(root, "_devices", "remoted", "target", "release", `intentic-remoted${exe}`);
    return existsSync(candidate) ? candidate : undefined;
};

export interface RemotedBinaryIo {
    readonly env: NodeJS.ProcessEnv;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
    readonly exists: (path: string) => boolean;
    readonly localBuild: () => string | undefined;
    // What the remoted at `path` says its version is; undefined for one that does not answer.
    readonly versionOf: (path: string) => string | undefined;
    // Puts release `version`'s remoted at `path`, checked, or throws saying why.
    readonly fetch: (version: string, path: string) => Promise<void>;
    readonly log: (message: string) => void;
}

/**
 * The remoted to start for an agent of `version`: the override, else (from source) the checkout's own build, else the
 * one in bin/ once it answers this agent's version, fetched first when it does not. Throws RemotedUnavailable, saying why.
 */
export const resolveRemoted = async (version: string, io: RemotedBinaryIo, target: string = remotedPath): Promise<string> => {
    const override = io.env[REMOTED_BIN_ENV] ?? "";
    if (override !== "") {
        if (!io.exists(override)) {
            throw new RemotedUnavailable(`${REMOTED_BIN_ENV} names ${override}, which does not exist on this computer.`);
        }
        return override;
    }
    if (version === DEV_VERSION) {
        const local = io.localBuild();
        if (local === undefined) {
            throw new RemotedUnavailable(
                `this intentic-machine was built from source (${DEV_VERSION}), which has no release to download intentic-remoted from, and _devices/remoted/target/release holds no build of it: run \`cargo build --release\` in _devices/remoted, or set ${REMOTED_BIN_ENV}.`,
            );
        }
        return local;
    }
    if (!remotedPublishedFor(io.platform, io.arch) && !io.exists(target)) {
        throw new RemotedUnavailable(
            `no intentic-remoted is published for ${io.platform} on ${io.arch}, so people cannot reach this computer remotely.`,
        );
    }
    const had = io.exists(target) ? io.versionOf(target) : undefined;
    if (had === version) {
        return target;
    }
    io.log(
        `remoted: ${had === undefined ? "none in bin/" : `the one in bin/ is ${had}`}; fetching intentic-remoted ${version} from this agent's release`,
    );
    try {
        await io.fetch(version, target);
    } catch (error) {
        throw new RemotedUnavailable(`intentic-remoted ${version} could not be fetched (${errorMessage(error)}).`, { cause: error });
    }
    return target;
};

// Download beside the target, check against the release's signed SHA256SUMS, and rename into place: a binary that is
// half there or not the release's never runs. Nothing is resumed; a remoted is a few megabytes.
const fetchRemoted = async (version: string, target: string): Promise<void> => {
    const part = `${target}.download`;
    try {
        await downloadAsset(releaseAssetUrl(version, remotedAssetName()), part);
        await verifyReleaseFiles(version, [{ name: remotedAssetName(), path: part }]);
        if (process.platform !== "win32") {
            await chmod(part, 0o755);
        }
        // A remoted from before may still be running elsewhere on Windows, which renames a running file but never replaces it.
        await vacate(target);
        await renameOver(part, target);
    } finally {
        // allow(silent-catch): gone already after the rename; a part that will not go is overwritten by the next fetch
        await rm(part, { force: true }).catch(() => undefined);
    }
};

export const realRemotedIo = (log: (message: string) => void): RemotedBinaryIo => ({
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    exists: existsSync,
    localBuild: () => localRemotedBuild(),
    versionOf,
    fetch: fetchRemoted,
    log,
});
