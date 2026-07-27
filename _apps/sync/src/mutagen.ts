import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { binDir, type Log, type SyncConfig } from "./config.js";
import { IGNORES, sanitizeId, sshAlias } from "./ssh.js";

// Pinned tool versions. cloudflared matches the sandbox image's pin so both ends speak the same tunnel protocol.
const MUTAGEN_VERSION = "0.18.1";
const CLOUDFLARED_VERSION = "2026.7.2";

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

// Everything a file-sync session is made of: the two endpoints plus the name that lets every other command find
// it again. One shape describes both what we WOULD create and what a live session is compared against, so the
// two can't drift apart in code.
export interface SyncSessionSpec {
    readonly name: string;
    readonly localDir: string;
    readonly alias: string;
    readonly remoteDir: string;
}

// The session for a config: name and ssh alias both namespace on the sandbox id, and the remote side is always
// /work — the sandbox's workspace root is the only thing there is to sync.
const sessionSpec = (config: SyncConfig & { readonly localDir: string }): SyncSessionSpec => ({
    name: sessionName(config.sandboxId),
    localDir: config.localDir,
    alias: sshAlias(config.sandboxId),
    remoteDir: "/work",
});

// `mutagen sync create` args: two-way-safe (flags conflicts rather than clobber), our ignore set, and
// neighboring staging on the remote so a huge file stages on the same filesystem as /work (atomic rename, no
// cross-fs 2× copy). local first, then user@alias:/work. The sync mode is pinned explicitly — Mutagen's default
// is two-way-safe, but relying on the default lets a version bump or a user's global mutagen config silently
// switch it to a clobbering mode; pinning keeps conflicts flagged, never overwritten.
//
// No --ignore-vcs: a nested repo's .git is meant to travel (it is what makes a synced project a REPO inside the
// sandbox rather than loose files under the root scope), and the one .git that must NOT is the workspace root's
// pointer file — which --ignore-vcs misses anyway, since its patterns match directories. IGNORES carries the
// anchored `/.git` that actually covers it; see the comment there.
export const mutagenCreateArgs = (spec: SyncSessionSpec, paused: boolean): string[] => [
    "sync",
    "create",
    "--name",
    spec.name,
    "--sync-mode",
    "two-way-safe",
    ...(paused ? ["--paused"] : []),
    ...IGNORES.flatMap((pattern) => ["--ignore", pattern]),
    "--stage-mode-beta",
    "neighboring",
    spec.localDir,
    `${spec.alias}:${spec.remoteDir}`,
];

// A live session as the daemon reports it, narrowed to what the drift check reads. Protobuf JSON omits
// defaults, so a session with no ignores at all arrives as `"ignore":{}` and vcs:false is simply absent.
interface LiveSession {
    readonly alpha: { readonly path?: string };
    readonly beta: { readonly host?: string; readonly path?: string };
    readonly ignore: { readonly paths?: readonly string[]; readonly vcs?: boolean };
    readonly paused?: boolean;
}

// The session of this name as the daemon has it, or undefined when there is none. A non-zero exit is Mutagen's
// "specification did not match any sessions" — or its daemon being unreachable, in which case the create that
// follows fails loudly with the real reason, which is what we want anyway.
const readSession = (mutagen: string, name: string): LiveSession | undefined => {
    const result = spawnSync(mutagen, ["sync", "list", "--template", "{{json .}}", name], { encoding: "utf8" });
    if (result.status !== 0) {
        return undefined;
    }
    return (JSON.parse(result.stdout) as LiveSession[])[0];
};

// Whether what's running is what THIS build would create. Both endpoints and the WHOLE ignore set count:
// Mutagen freezes a session's configuration at `sync create` and has no verb that edits it afterwards, so an
// ignore list that no longer matches is a session that will never behave like this version says it does.
export const sessionMatchesSpec = (session: LiveSession, spec: SyncSessionSpec): boolean =>
    session.alpha.path === spec.localDir &&
    session.beta.host === spec.alias &&
    session.beta.path === spec.remoteDir &&
    session.ignore.vcs !== true &&
    (session.ignore.paths ?? []).join("\n") === IGNORES.join("\n");

// Converge the file-sync session on this build: create it when missing, recreate it when what's running drifted.
// Recreating is the only way to change a session's ignores, and that is what makes an agent upgrade actually
// reach a machine that is ALREADY paired — without it, a pairing made before a rule changed keeps syncing on
// the old rules forever, silently, with `status` reporting a perfectly healthy "Watching for changes". That is
// exactly how every project's .git stayed out of sandboxes long after --ignore-vcs was dropped here.
//
// The recreate is cheap where it counts: content that already matches on both ends reconciles without transfer,
// so it costs a rescan, not a re-download. A paused session is recreated paused — drift gets fixed without
// overriding a deliberate `intentic-sync pause`.
export const ensureSyncSession = (mutagen: string, config: SyncConfig, log: Log): void => {
    if (config.mode !== "sync" || config.localDir === undefined) {
        return; // a mirror-only enrollment has no file sync at all — just port forwards
    }
    const spec = sessionSpec({ ...config, localDir: config.localDir });
    const live = readSession(mutagen, spec.name);
    if (live !== undefined && sessionMatchesSpec(live, spec)) {
        return;
    }
    if (live !== undefined) {
        log(
            "the running sync session was created by an older agent — recreating it so this version's rules apply (a project's .git travels with it; /work's own pointer file doesn't).",
        );
        spawnSync(mutagen, ["sync", "terminate", spec.name], { stdio: "ignore" });
    }
    runMutagen(mutagen, mutagenCreateArgs(spec, live?.paused === true));
};

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
