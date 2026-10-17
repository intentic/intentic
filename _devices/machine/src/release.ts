import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { livePidRecord, WINDOWS_LAUNCH_STUB } from "@intentic/local-agent";
import { binDir, upgradeLockPath } from "./config.js";

// The release channel and how a binary from it lands on disk: every install, upgrade and version probe reads this file.

export const exe = process.platform === "win32" ? ".exe" : "";

export const osToken = (): "linux" | "darwin" | "windows" => {
    if (process.platform === "linux" || process.platform === "darwin") {
        return process.platform;
    }
    if (process.platform === "win32") {
        return "windows";
    }
    throw new Error(`auto-download isn't supported on ${process.platform}: install mutagen and cloudflared manually, then re-run.`);
};

export const archToken = (): "amd64" | "arm64" => {
    if (process.arch === "x64") {
        return "amd64";
    }
    if (process.arch === "arm64") {
        return "arm64";
    }
    throw new Error(`unsupported CPU arch ${process.arch}: install mutagen and cloudflared manually, then re-run.`);
};

export const agentPath = join(binDir, `intentic-machine${exe}`);
export const launcherPath = join(binDir, WINDOWS_LAUNCH_STUB);

const RELEASES = "https://github.com/intentic/intentic/releases";

// Always a tag: every environment of one machine must land on the same bytes, and only a tag names them.
export const releaseAssetUrl = (version: string, name: string): string => `${RELEASES}/download/v${version}/${name}`;
// The asset names as the release attaches them, which are also the names its SHA256SUMS lists them by.
export const agentAssetName = (): string => `intentic-machine-${osToken()}-${archToken()}${exe}`;
export const launcherAssetName = (): string => `intentic-launch-windows-${archToken()}.exe`;
export const agentAssetUrl = (version: string): string => releaseAssetUrl(version, agentAssetName());
export const launcherAssetUrl = (version: string): string => releaseAssetUrl(version, launcherAssetName());

// intentic-keyring, the vault beside this agent (keyring/), and intentic-askpass, the same binary under a second name (a
// hard link). They live in this bin/ but are this agent's to install, never to update: nothing in an upgrade, a sweep or
// a rollback touches them, and the keyring moves to a new release only through `intentic-machine keyring upgrade`,
// which the running keyring asks a person about first.
export const keyringPath = join(binDir, `intentic-keyring${exe}`);
export const askpassPath = join(binDir, `intentic-askpass${exe}`);
export const keyringAssetName = (): string => `intentic-keyring-${osToken()}-${archToken()}${exe}`;

// `releases/latest` redirects to `…/tag/vX.Y.Z`; the API answers the same but is rate-limited per IP.
export const publishedVersion = async (): Promise<string | undefined> => {
    try {
        const response = await fetch(`${RELEASES}/latest`, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(20_000) });
        return /\/tag\/v(\d+\.\d+\.\d+)$/.exec(response.url)?.[1];
    } catch {
        return undefined;
    }
};

// A cold ~90 MB binary on a busy laptop still prints one line well inside this; a wedged one has no version.
const PROBE_TIMEOUT_MS = 30_000;

// The bare release a working agent prints; undefined for a file that won't run, fails, or answers anything else.
export const versionOf = (binary: string): string | undefined => {
    const result = spawnSync(binary, ["version"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    return result.error === undefined && result.status === 0 ? /^\d+\.\d+\.\d+$/.exec(result.stdout.trim())?.[0] : undefined;
};

// What a download may do beyond arriving: resume needs a destination name that means one set of bytes.
export interface DownloadOptions {
    readonly resume?: boolean;
    readonly onProgress?: (received: number, total: number) => void;
}

const fileSize = async (path: string): Promise<number> => {
    try {
        return (await stat(path)).size;
    } catch {
        return 0;
    }
};

// A URL that answered 404: for a release asset's .gz copy, a release from before the copies were published.
class AssetMissingError extends Error {}

// 416 is a range past the end (the caller decides), 206 continues the file, 200 is the whole file again.
const openDownload = async (
    url: string,
    have: number,
): Promise<{ readonly body: ReadableStream<Uint8Array>; readonly total: number; readonly appending: boolean } | undefined> => {
    const response = await fetch(url, have > 0 ? { headers: { range: `bytes=${have}-` } } : {});
    if (response.status === 416 && have > 0) {
        return undefined;
    }
    if (response.status === 404) {
        throw new AssetMissingError(`not found (404): ${url}`);
    }
    if (!response.ok || response.body === null) {
        throw new Error(`download failed (${response.status}): ${url}`);
    }
    const appending = response.status === 206;
    // A 206 without a length reports a total of zero, never `have`, or a half-finished download would read as complete.
    const length = Number(response.headers.get("content-length") ?? 0);
    return { body: response.body, total: length > 0 ? (appending ? have + length : length) : 0, appending };
};

// A failure mid-flight leaves the part file where it is, for the next attempt to resume.
const drainInto = async (
    file: WriteStream,
    body: ReadableStream<Uint8Array>,
    from: number,
    total: number,
    onProgress: DownloadOptions["onProgress"],
): Promise<void> => {
    const reader = body.getReader();
    let received = from;
    try {
        for (;;) {
            // one read at a time IS the transfer
            const chunk = await reader.read();
            if (chunk.done) {
                break;
            }
            received += chunk.value.byteLength;
            onProgress?.(received, total);
            if (!file.write(chunk.value)) {
                // backpressure: waiting here is the point
                await once(file, "drain");
            }
        }
        file.end();
        await once(file, "close");
    } catch (error) {
        file.destroy();
        throw error;
    }
};

export const download = async (url: string, dest: string, options: DownloadOptions = {}): Promise<void> => {
    await mkdir(dirname(dest), { recursive: true });
    const have = options.resume === true ? await fileSize(dest) : 0;
    const stream = await openDownload(url, have);
    if (stream === undefined) {
        return;
    }
    const file = createWriteStream(dest, stream.appending ? { flags: "a" } : {});
    await drainInto(file, stream.body, stream.appending ? have : 0, stream.total, options.onProgress);
};

/**
 * A release binary into `dest`: by the `.gz` copy each release publishes beside it (gzip -9, under half the bytes: 42 of
 * the agent's 92 MB) where there is one, else by the binary itself, which a release from before the copies answers
 * with. The copy downloads to `<dest>.gz`, resumable under `resume` like the binary, and is unpacked into `dest` once
 * whole; `onProgress` counts the bytes that cross. Whatever verifies `dest` afterwards checks the binary's own sum.
 */
export const downloadAsset = async (url: string, dest: string, options: DownloadOptions = {}): Promise<void> => {
    const packed = `${dest}.gz`;
    try {
        await download(`${url}.gz`, packed, options);
    } catch (error) {
        if (!(error instanceof AssetMissingError)) {
            throw error;
        }
        await rm(packed, { force: true });
        await download(url, dest, options);
        return;
    }
    try {
        await pipeline(createReadStream(packed), createGunzip(), createWriteStream(dest));
    } finally {
        // A copy that does not unpack is no better resumed: the next attempt starts it over.
        await rm(packed, { force: true });
    }
};

// Every binary replacement is renames, since Windows renames a running executable but never overwrites it; no source moves nothing.
export const renameIfPresent = async (from: string, to: string): Promise<void> => {
    await rename(from, to).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
            throw error;
        }
    });
};

// What a finished swap or an extracted tarball leaves in bin/. Versioned part files stay: the next attempt resumes them.
// So does `.previous`: it is what undoes an update whose agent keeps crashing, and only that agent's trial drops it
// (agent-trial.ts), once it has run for ten minutes. Each pattern names its program, so the keyring's files
// (`intentic-keyring*`, `intentic-askpass*`, its own `.previous` among them) never match: they are `keyring upgrade`'s.
const LEFTOVER = [
    /^intentic-machine(?:\.exe)?\.old$/,
    /^intentic-launch\.exe\.(?:old|tmp(?:\.gz)?)$/,
    /^mutagen(?:\.exe)?\.old$/,
    /^mutagen\.tar\.gz$/,
];

export const isLeftover = (name: string): boolean => LEFTOVER.some((pattern) => pattern.test(name));

// Only between upgrades: a part file or a rollback copy is live while one runs. A file still executing stays until next time.
export const sweepBin = async (): Promise<void> => {
    if ((await livePidRecord(upgradeLockPath)) !== undefined) {
        return;
    }
    const names = await readdir(binDir).catch(() => []);
    await Promise.all(names.filter(isLeftover).map(async (name) => await rm(join(binDir, name), { force: true }).catch(() => undefined)));
};
