import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { promisify } from "node:util";
import { SingleFlight } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { EngineId } from "@intentic/sandbox-contract/schemas/engines";
import { recordedSha256 } from "./engine-channel.js";
import { engineDescriptor, type EngineDescriptor } from "./engine-descriptors.js";
import { activateVersion, collectGarbage, engineDir, engineVersionDir, installedVersions, quarantineVersion } from "./engine-store.js";
import { forgetEngineResolution } from "./engine-resolve.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { z } from "zod";

// Gets a version onto the volume and refuses to serve it until verified; downloading is npm's job (or a release's, or a
// vendor CDN's), this file only asks
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

// Writes a download to disk while hashing it, so a file of hundreds of megabytes is never held in memory and its hash is
// known before anything reads what was written.
const writeHashed = async (body: NonNullable<Response["body"]>, target: string, mode: number): Promise<{ sha256: string; size: number }> => {
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(
        async function* hashed() {
            for await (const chunk of body) {
                hash.update(chunk);
                size += chunk.length;
                yield chunk;
            }
        },
        createWriteStream(target, { mode }),
    );
    return { sha256: hash.digest("hex"), size };
};

// The one engine published as a release asset, not npm. Downloaded whole, unpacked, and reduced to just the named
// binary; the archive's configs and docs would otherwise sit in the store forever. `sha256` is the hash this repository
// recorded for this very version and build (engine-channel.ts `recordedSha256`): the download is refused unless it
// matches, and checked before tar reads a byte of it. GitHub's own per-asset digest would not do: an asset uploaded
// again gets a new one, so only a hash recorded here when the version was blessed says the bytes are the ones blessed.
export const releaseInstall = async (descriptor: EngineDescriptor, version: string, prefix: string, sha256?: string): Promise<void> => {
    if (descriptor.source.kind !== "github-release") {
        throw new Error(`${descriptor.id} is not a release engine`);
    }
    const { repo, arch, asset, binary } = descriptor.source;
    const name = asset(version, arch());
    const url = `https://github.com/${repo}/releases/download/v${version}/${name}`;
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || response.body === null) {
        throw new Error(`${url} answered ${response.status}`);
    }
    const archive = join(prefix, "asset.tar.gz");
    const downloaded = await writeHashed(response.body, archive, 0o644);
    // No recorded hash means a version nobody blessed with one: a `latest` or `pinned` channel naming its own, which is
    // installed unchecked, as every release was before hashes were recorded. The engines check holds every blessed
    // release version to a hash for each build it publishes.
    if (sha256 !== undefined && downloaded.sha256 !== sha256) {
        // Thrown like a failed download (stage() removes the prefix and quarantines nothing): the bytes upstream serves
        // are what is wrong, and a re-recorded hash or a newer blessing reaches the fleet within the hour, where a
        // standing refusal would outlive both.
        throw new Error(
            `${name} does not match the sha256 recorded for ${descriptor.id} ${version} in engines.json ` +
                `(expected ${sha256}, downloaded ${downloaded.sha256}); refused, and the current copy keeps serving`,
        );
    }
    const unpack = join(prefix, ".unpack");
    await mkdir(unpack, { recursive: true });
    // Never as the archive's recorded owners: the daemon runs as root, and a release tarball's uid means nothing here.
    await execFileAsync("tar", ["-xzf", archive, "--no-same-owner", "-C", unpack], { timeout: INSTALL_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    const found = await findFile(unpack, binary);
    if (found === undefined) {
        throw new Error(`${name} contains no ${binary}`);
    }
    await rename(found, join(prefix, binary));
    await chmod(join(prefix, binary), 0o755);
    await rm(unpack, { recursive: true, force: true });
    await rm(archive, { force: true });
};

// An engine published as one gzipped binary (Grok Build): the download is held whole (~75 MB) and gunzipped as a stream
// to the prefix, so the unpacked binary (~170 MB) never sits in memory.
export const downloadInstall = async (descriptor: EngineDescriptor, version: string, prefix: string): Promise<void> => {
    if (descriptor.source.kind !== "download") {
        throw new Error(`${descriptor.id} is not a download engine`);
    }
    const url = descriptor.source.artifact(version);
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
    }
    const target = join(prefix, descriptor.source.binary);
    await pipeline(Readable.from([Buffer.from(await response.arrayBuffer())]), createGunzip(), createWriteStream(target, { mode: 0o755 }));
    await chmod(target, 0o755);
};

// One platform's binary as Meta's per-version manifest lists it; anything else in the document is ignored.
const MetaArtifactSchema = z.object({ url: z.url(), checksum: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().positive() });
const MetaManifestSchema = z.object({
    version: z.string(),
    checksum_algorithm: z.literal("sha256"),
    artifacts: z.record(z.string(), z.unknown()),
});

// Muse Code's binary, the way Meta's own launcher fetches it: the version's manifest names this platform's file with its
// sha256 and size, and a download either matches both or is thrown away. Streamed to disk while hashed, since the file
// runs to ~350 MB and holding it in memory would cost the daemon that much.
export const metaReleaseInstall = async (descriptor: EngineDescriptor, version: string, prefix: string): Promise<void> => {
    if (descriptor.source.kind !== "meta-release") {
        throw new Error(`${descriptor.id} is not a Meta release engine`);
    }
    const { manifestUrl, platform, binary } = descriptor.source;
    const manifestAt = manifestUrl(version);
    const answer = await fetch(manifestAt, { redirect: "follow", headers: { accept: "application/json" } });
    if (!answer.ok) {
        throw new Error(`${manifestAt} answered ${answer.status}`);
    }
    const manifest = MetaManifestSchema.safeParse(await answer.json());
    if (!manifest.success || manifest.data.version !== version) {
        throw new Error(`Meta's manifest for ${descriptor.id} ${version} is not one this daemon can read`);
    }
    const artifact = MetaArtifactSchema.safeParse(manifest.data.artifacts[platform]);
    if (!artifact.success) {
        throw new Error(`${descriptor.id} ${version} has no build for ${platform}`);
    }
    const download = await fetch(artifact.data.url, { redirect: "follow" });
    if (!download.ok || download.body === null) {
        throw new Error(`${descriptor.id} ${version} download answered ${download.status}`);
    }
    const target = join(prefix, binary);
    const { sha256, size } = await writeHashed(download.body, target, 0o755);
    if (size !== artifact.data.size || sha256 !== artifact.data.checksum) {
        throw new Error(`${descriptor.id} ${version} download does not match the checksum Meta published for it`);
    }
    await chmod(target, 0o755);
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
const installing = new SingleFlight<EngineId, EngineInstallOutcome>();

export const isEngineInstalling = (id: EngineId): boolean => installing.joined(id) !== undefined;

// Puts a version on the volume and makes it the one turns use, or says why not. Order is download, verify, move the
// pointer; every failure path leaves the previous version (usually the image's copy) serving turns.
export const installEngine = (id: EngineId, version: string): Promise<EngineInstallOutcome> => {
    const inFlight = installing.joined(id);
    if (inFlight !== undefined) {
        return inFlight;
    }
    const run = installing.run(id, () => installOnce(id, version));
    publishRuntimeChange("engines");
    // Published once the run has left `installing`, so a reader of the change sees the install over.
    return run.finally(() => publishRuntimeChange("engines"));
};

const installOnce = async (id: EngineId, version: string): Promise<EngineInstallOutcome> => {
    const descriptor = engineDescriptor(id);
    // Not quarantined: the version is fine, this daemon is the wrong one for it, and a later build may drive it.
    const refusal = descriptor.incompatible?.(version);
    if (refusal !== undefined) {
        return { ok: false, version, reason: refusal, quarantined: false };
    }
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

// The one place a source kind picks its download.
const fetchInto = (descriptor: EngineDescriptor, version: string, prefix: string): Promise<void> => {
    switch (descriptor.source.kind) {
        case "npm":
            return npmInstall(descriptor, version, prefix);
        case "github-release":
            return recordedSha256(descriptor.id, version).then((sha256) => releaseInstall(descriptor, version, prefix, sha256));
        case "download":
            return downloadInstall(descriptor, version, prefix);
        case "meta-release":
            return metaReleaseInstall(descriptor, version, prefix);
    }
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
        await fetchInto(descriptor, version, prefix);
        await descriptor.afterInstall?.(prefix);
        return { ok: true, prefix };
    } catch (error) {
        await rm(prefix, { recursive: true, force: true });
        // Not quarantined: a 404, timeout or full disk says nothing about the version, and a download unlike its recorded
        // hash is cured by the list (the hash recorded again, a newer version blessed), which a standing refusal would
        // outlive; retry freely next time.
        return { ok: false, version, reason: errorMessage(error), quarantined: false };
    }
};
