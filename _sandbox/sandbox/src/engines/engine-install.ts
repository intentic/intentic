import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "@intentic/base/errors";
import type { EngineId } from "@intentic/sandbox-contract";
import { engineDescriptor, type EngineDescriptor } from "./engine-descriptors.js";
import { activateVersion, collectGarbage, engineDir, engineVersionDir, installedVersions, quarantineVersion } from "./engine-store.js";
import { forgetEngineResolution } from "./engine-resolve.js";

// Gets a version onto the volume and refuses to serve it until verified; downloading is npm's job, this file only asks
// whether the version still works with this daemon. Installs to a temp prefix and renames into `versions/<version>`
// only when complete and verified: nothing is upgraded in place.

const execFileAsync = promisify(execFile);

// Long enough for a large download plus npm's own retries; too short looks broken on the first try.
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const MAX_BUFFER = 8 * 1024 * 1024;

export type EngineInstallOutcome =
    | { readonly ok: true; readonly version: string; readonly reused: boolean }
    // `quarantined` separates a bad version (standing refusal) from a failed download (worth retrying).
    | { readonly ok: false; readonly version: string; readonly reason: string; readonly quarantined: boolean };

const npmInstall = async (descriptor: EngineDescriptor, version: string, prefix: string): Promise<void> => {
    if (descriptor.source.kind !== "npm") {
        throw new Error(`${descriptor.id} is not an npm engine`);
    }
    await execFileAsync(
        "npm",
        [
            "install",
            "--prefix",
            prefix,
            "--no-save",
            "--no-package-lock",
            // Neither matters for a single pinned install; both cost a network round trip on the fast path.
            "--no-audit",
            "--no-fund",
            `${descriptor.source.package}@${version}`,
        ],
        { timeout: INSTALL_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
    );
};

// The one engine published as a release asset, not npm. Downloaded whole, unpacked, and reduced to just the named
// binary; the archive's configs and docs would otherwise sit in the store forever.
const releaseInstall = async (descriptor: EngineDescriptor, version: string, prefix: string): Promise<void> => {
    if (descriptor.source.kind !== "github-release") {
        throw new Error(`${descriptor.id} is not a release engine`);
    }
    const { repo, asset, binary } = descriptor.source;
    const url = `https://github.com/${repo}/releases/download/v${version}/${asset(version)}`;
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
    }
    const unpack = join(prefix, ".unpack");
    await mkdir(unpack, { recursive: true });
    const archive = join(prefix, "asset.tar.gz");
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    await execFileAsync("tar", ["-xzf", archive, "-C", unpack], { timeout: INSTALL_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    const found = await findFile(unpack, binary);
    if (found === undefined) {
        throw new Error(`${asset(version)} contains no ${binary}`);
    }
    await rename(found, join(prefix, binary));
    await chmod(join(prefix, binary), 0o755);
    await rm(unpack, { recursive: true, force: true });
    await rm(archive, { force: true });
};

const findFile = async (dir: string, name: string): Promise<string | undefined> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isFile() && entry.name === name) {
            return path;
        }
        if (entry.isDirectory()) {
            const nested = await findFile(path, name);
            if (nested !== undefined) {
                return nested;
            }
        }
    }
    return undefined;
};

// One install per engine at a time; concurrent callers share the answer, and failures clear so Retry retries.
const installing = new Map<EngineId, Promise<EngineInstallOutcome>>();

export const isEngineInstalling = (id: EngineId): boolean => installing.has(id);

// Puts a version on the volume and makes it the one turns use, or says why not. Order is download, verify, move the
// pointer; every failure path leaves the previous version (usually the image's copy) serving turns.
export const installEngine = (id: EngineId, version: string): Promise<EngineInstallOutcome> => {
    const inFlight = installing.get(id);
    if (inFlight !== undefined) {
        return inFlight;
    }
    const run = installOnce(id, version).finally(() => installing.delete(id));
    installing.set(id, run);
    return run;
};

const installOnce = async (id: EngineId, version: string): Promise<EngineInstallOutcome> => {
    const descriptor = engineDescriptor(id);
    const target = engineVersionDir(id, version);
    const reused = (await installedVersions(id)).includes(version);
    if (!reused) {
        const staged = await stage(descriptor, version);
        if (!staged.ok) {
            return staged;
        }
        await mkdir(engineDir(id), { recursive: true });
        await mkdir(join(engineDir(id), "versions"), { recursive: true });
        await rename(staged.prefix, target).catch(async (error: unknown) => {
            await rm(staged.prefix, { recursive: true, force: true });
            throw error;
        });
    }
    // Verified even when already installed: "on disk" and "works" differ after an arch or libc change.
    const problem = await descriptor.verify(target);
    if (problem !== undefined) {
        await quarantineVersion(id, version, problem, new Date().toISOString());
        await rm(target, { recursive: true, force: true });
        forgetEngineResolution(id);
        return { ok: false, version, reason: problem, quarantined: true };
    }
    await activateVersion(id, version);
    forgetEngineResolution(id);
    // After the pointer moves, never before: a GC that ran first would be deleting the copy still serving turns.
    await collectGarbage(id);
    return { ok: true, version, reused };
};

// Downloads into a temp prefix on the store's own filesystem, so the later rename cannot cross a device. Returns the
// staged prefix; the caller owns moving or removing it.
const stage = async (
    descriptor: EngineDescriptor,
    version: string,
): Promise<{ ok: true; prefix: string } | { ok: false; version: string; reason: string; quarantined: false }> => {
    const staging = join(engineDir(descriptor.id), ".staging");
    await mkdir(staging, { recursive: true }).catch(() => undefined);
    const prefix = await mkdtemp(join(staging, `${version}-`)).catch(() => mkdtemp(join(tmpdir(), `engine-${descriptor.id}-`)));
    try {
        await (descriptor.source.kind === "npm" ? npmInstall(descriptor, version, prefix) : releaseInstall(descriptor, version, prefix));
        return { ok: true, prefix };
    } catch (error) {
        await rm(prefix, { recursive: true, force: true });
        // Not quarantined: a 404, timeout, or full disk says nothing about the version; retry freely next time.
        return { ok: false, version, reason: errorMessage(error), quarantined: false };
    }
};
