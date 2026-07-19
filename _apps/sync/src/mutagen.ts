import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { binDir } from "./config.js";
import { IGNORES, sanitizeId } from "./ssh.js";

// Pinned tool versions. cloudflared matches the sandbox image's pin so both ends speak the same tunnel protocol.
const MUTAGEN_VERSION = "0.18.1";
const CLOUDFLARED_VERSION = "2026.6.1";

// The Mutagen session name (letters/digits/dashes) so `mutagen sync {list,pause,resume,terminate}` can target it.
export const sessionName = (sandboxId: string): string => `intentic-${sanitizeId(sandboxId)}`;

// One port-mirror forward session per port, deterministically named so `mirror` can reconcile (terminate a
// vanished port's session, recreate a live one) without querying Mutagen's session list.
export const forwardSessionName = (sandboxId: string, port: number): string => `intentic-fwd-${sanitizeId(sandboxId)}-${port}`;

// `mutagen forward create` args: bind the SAME port on the local loopback and pipe it to the sandbox listener
// at its recorded loopback address — `host` is the daemon-reported dial host, because a `localhost` bind inside
// the sandbox can land on ::1 only (Vite), where dialing 127.0.0.1 is connection-refused. TCP-level, so a
// dev server's TLS passes through untouched and the local browser sees exactly what a local dev server serves.
export const mutagenForwardArgs = (args: {
    readonly name: string;
    readonly port: number;
    readonly alias: string;
    readonly host: string;
}): string[] => [
    "forward",
    "create",
    "--name",
    args.name,
    `tcp:127.0.0.1:${args.port}`,
    `${args.alias}:tcp:${args.host.includes(":") ? `[${args.host}]` : args.host}:${args.port}`,
];

// `mutagen sync create` args: two-way-safe (flags conflicts rather than clobber), our ignore set, and
// neighboring staging on the remote so a huge file stages on the same filesystem as /work (atomic rename, no
// cross-fs 2× copy). local first, then user@alias:/work. The sync mode is pinned explicitly — Mutagen's default
// is two-way-safe, but relying on the default lets a version bump or a user's global mutagen config silently
// switch it to a clobbering mode; pinning keeps conflicts flagged, never overwritten.
export const mutagenCreateArgs = (args: {
    readonly name: string;
    readonly localDir: string;
    readonly alias: string;
    readonly remoteDir: string;
}): string[] => [
    "sync",
    "create",
    "--name",
    args.name,
    "--sync-mode",
    "two-way-safe",
    "--ignore-vcs",
    ...IGNORES.flatMap((pattern) => ["--ignore", pattern]),
    "--stage-mode-beta",
    "neighboring",
    args.localDir,
    `${args.alias}:${args.remoteDir}`,
];

const osToken = (): "linux" | "darwin" | "windows" => {
    if (process.platform === "linux" || process.platform === "darwin") {
        return process.platform;
    }
    if (process.platform === "win32") {
        return "windows";
    }
    throw new Error(`auto-download isn't supported on ${process.platform} — install mutagen and cloudflared manually, then re-run.`);
};

const exe = process.platform === "win32" ? ".exe" : "";

const archToken = (): "amd64" | "arm64" => {
    if (process.arch === "x64") {
        return "amd64";
    }
    if (process.arch === "arm64") {
        return "arm64";
    }
    throw new Error(`unsupported CPU arch ${process.arch} — install mutagen and cloudflared manually, then re-run.`);
};

const onPath = (binary: string, versionArgs: string[]): boolean => {
    const result = spawnSync(binary, versionArgs, { stdio: "ignore" });
    return result.error === undefined && result.status === 0;
};

const download = async (url: string, dest: string): Promise<void> => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`download failed (${response.status}): ${url}`);
    }
    await mkdir(binDir, { recursive: true });
    await writeFile(dest, new Uint8Array(await response.arrayBuffer()));
};

// Extract a gzipped tarball into ~/.intentic/sync/bin using the system `tar` (bsdtar on macOS/Windows 10+).
const extractTarball = (tarball: string): void => {
    const extract = spawnSync("tar", ["-xzf", tarball, "-C", binDir], { stdio: "inherit" });
    if (extract.status !== 0) {
        throw new Error(`failed to extract ${tarball} (is \`tar\` installed?)`);
    }
};

// Resolve cloudflared: on PATH, else download the release to ~/.intentic/sync/bin. Asset shapes differ per OS:
// bare binary on linux, .tgz on darwin, .exe on windows (amd64 only — no windows-arm64 build exists).
export const ensureCloudflared = async (): Promise<string> => {
    if (onPath("cloudflared", ["--version"])) {
        return "cloudflared";
    }
    const os = osToken();
    const base = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;
    const dest = join(binDir, `cloudflared${exe}`);
    if (os === "darwin") {
        const tgz = join(binDir, "cloudflared.tgz");
        await download(`${base}/cloudflared-darwin-${archToken()}.tgz`, tgz);
        extractTarball(tgz);
    } else if (os === "windows") {
        if (archToken() !== "amd64") {
            throw new Error("cloudflared has no windows-arm64 build — install cloudflared manually, then re-run.");
        }
        await download(`${base}/cloudflared-windows-amd64.exe`, dest);
    } else {
        await download(`${base}/cloudflared-linux-${archToken()}`, dest);
    }
    await chmod(dest, 0o755);
    return dest;
};

// Resolve mutagen: on PATH, else download+extract the release tarball (binary + agent bundle side by side, as
// Mutagen requires) to ~/.intentic/sync/bin using the system `tar`.
export const ensureMutagen = async (): Promise<string> => {
    if (onPath("mutagen", ["version"])) {
        return "mutagen";
    }
    const dest = join(binDir, `mutagen${exe}`);
    const tarball = join(binDir, "mutagen.tar.gz");
    await download(
        `https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/mutagen_${osToken()}_${archToken()}_v${MUTAGEN_VERSION}.tar.gz`,
        tarball,
    );
    extractTarball(tarball);
    await chmod(dest, 0o755);
    return dest;
};

// Run a mutagen subcommand, inheriting stdio; throw on failure so the CLI surfaces it.
export const runMutagen = (mutagen: string, args: string[]): SpawnSyncReturns<Buffer> => {
    const result = spawnSync(mutagen, args, { stdio: "inherit" });
    if (result.error !== undefined) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`mutagen ${args[0] ?? ""} exited with code ${result.status}`);
    }
    return result;
};
