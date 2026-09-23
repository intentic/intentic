import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
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
export const agentAssetUrl = (version: string): string => `${RELEASES}/download/v${version}/intentic-machine-${osToken()}-${archToken()}${exe}`;
export const launcherAssetUrl = (version: string): string => `${RELEASES}/download/v${version}/intentic-launch-windows-${archToken()}.exe`;

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

// 416 is a range past the end (the caller decides), 206 continues the file, 200 is the whole file again.
const openDownload = async (
    url: string,
    have: number,
): Promise<{ readonly body: ReadableStream<Uint8Array>; readonly total: number; readonly appending: boolean } | undefined> => {
    const response = await fetch(url, have > 0 ? { headers: { range: `bytes=${have}-` } } : {});
    if (response.status === 416 && have > 0) {
        return undefined;
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
            // oxlint-disable-next-line eslint/no-await-in-loop -- one read at a time IS the transfer
            const chunk = await reader.read();
            if (chunk.done) {
                break;
            }
            received += chunk.value.byteLength;
            onProgress?.(received, total);
            if (!file.write(chunk.value)) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- backpressure: waiting here is the point
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

// Every binary replacement is renames, since Windows renames a running executable but never overwrites it; no source moves nothing.
export const renameIfPresent = async (from: string, to: string): Promise<void> => {
    await rename(from, to).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
            throw error;
        }
    });
};

// What a finished swap or an extracted tarball leaves in bin/. Versioned part files stay: the next attempt resumes them.
const LEFTOVER = [
    /^intentic-machine(?:\.exe)?\.(?:old|previous)$/,
    /^intentic-launch\.exe\.(?:old|tmp|previous)$/,
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
