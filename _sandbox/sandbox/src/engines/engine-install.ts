import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EngineId } from "@intentic/sandbox-contract";
import { engineDescriptor, type EngineDescriptor } from "./engine-descriptors.js";
import { activateVersion, collectGarbage, engineDir, engineVersionDir, installedVersions, quarantineVersion } from "./engine-store.js";
import { forgetEngineResolution } from "./engine-resolve.js";

/* GETTING A VERSION ONTO THE VOLUME, and refusing to let it serve turns until it has answered for itself.
 *
 * DOWNLOADING IS npm's JOB, not this file's. `npm install --prefix` already resolves the package's
 * platform-specific optional dependency for THIS cpu and libc, verifies every tarball against the registry's
 * integrity hash, and retries a flaky network — reimplementing that here would be a second, worse npm whose
 * bugs would be ours. It is also exactly what packs/cursor.Dockerfile and cursor-sdk.ts's bootstrap already do,
 * so the store's copy and the pack's copy of a package are produced by the same command.
 *
 * WHAT THIS FILE ADDS is the question npm cannot answer: does this version still work with THIS daemon? A
 * download that finishes is not a version that runs — a platform package can be missing for the running
 * architecture, a binary can fail to exec against the image's glibc, and an SDK can drop an export the daemon
 * calls. Each of those would otherwise surface deep inside a turn, on every turn, until somebody noticed. So an
 * installed prefix is verified (engine-descriptors.ts) BEFORE the pointer moves, and a failure quarantines the
 * version rather than leaving it to be retried on the next check.
 *
 * NOTHING IS EVER UPGRADED IN PLACE. The install lands in a temp directory beside the store, and only a
 * complete, verified prefix is renamed into `versions/<version>`. A crash halfway leaves a temp directory and a
 * store nobody's turn ever noticed. */

const execFileAsync = promisify(execFile);

// A 300 MB platform binary over a home connection, with npm's own retries inside it. Long, because the failure
// mode of being too short is a version that installs fine on the second try and looks broken on the first.
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const MAX_BUFFER = 8 * 1024 * 1024;

export type EngineInstallOutcome =
    | { readonly ok: true; readonly version: string; readonly reused: boolean }
    // `quarantined` distinguishes "this version is bad" from "the download failed": only the first is a
    // standing refusal, the second is worth retrying on the next check.
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
            // Neither says anything about a single pinned install, and both cost a network round trip on a
            // path whose whole point is to be the fast way to move an engine.
            "--no-audit",
            "--no-fund",
            `${descriptor.source.package}@${version}`,
        ],
        { timeout: INSTALL_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
    );
};

/* The one engine published as a release asset rather than to npm. Downloaded whole, unpacked, and reduced to
 * the single binary the descriptor names: the archive also carries configs and docs that would otherwise sit
 * in the store forever, and the pack it mirrors keeps nothing else either. */
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

// One install per engine at a time, so two tabs pressing Update (or a check racing a click) do one download
// and share its answer. A failed one clears, so Retry really retries instead of inheriting a rejection.
const installing = new Map<EngineId, Promise<EngineInstallOutcome>>();

/* Put a version on the volume and make it the one turns use, or say why not.
 *
 * The order is the whole design: download → verify → move the pointer. Nothing between those steps can leave
 * the sandbox running a version that has not answered `--version` (or, for an in-process engine, an import),
 * and every failure path leaves the previous answer — usually the image's copy — serving turns. */
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
    /* Verified even when the directory was already there: "installed" and "works" are different claims, and the
     * copy on disk may predate a container whose architecture or libc has since changed under it (a volume
     * moved between machines, an image rebased). Re-asking costs one `--version` and closes that gap. */
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

// The download half, into a temp prefix on the store's own filesystem so the rename into place cannot cross a
// device. Returns the staged prefix; the caller owns moving or removing it.
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
        // Not quarantined: a 404, a timeout or a full disk says nothing about the version itself, and the next
        // check should be free to try again.
        return { ok: false, version, reason: error instanceof Error ? error.message : String(error), quarantined: false };
    }
};
