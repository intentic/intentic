import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Log } from "@intentic/local-agent";
import { binDir, type Pairing } from "./config.js";
import { IGNORES, sanitizeId, sshAlias } from "./ssh.js";

// Pinned tool versions. cloudflared matches the sandbox image's pin so both ends speak the same tunnel protocol.
const MUTAGEN_VERSION = "0.18.1";
const CLOUDFLARED_VERSION = "2026.7.2";

// The prefix every session this agent creates carries, sync and forward alike — what makes them all findable
// again later, whichever pairing created them (see ourSyncSessions / ourForwardSessions).
const SESSION_PREFIX = "intentic-";

// The Mutagen session name (letters/digits/dashes) so `mutagen sync {list,pause,resume,terminate}` can target it.
export const sessionName = (sandboxId: string): string => `${SESSION_PREFIX}${sanitizeId(sandboxId)}`;

// One port-mirror forward session per port, deterministically named so `mirror` can reconcile (terminate a
// vanished port's session, recreate a live one) without querying Mutagen's session list. The shared prefix is
// what makes every forward this agent has EVER created findable again, whichever pairing created it — the name
// carries the sandbox id, so a session outlives the config that could name it (see ourForwardSessions).
const FORWARD_PREFIX = "intentic-fwd-";
export const forwardSessionName = (sandboxId: string, port: number): string => `${FORWARD_PREFIX}${sanitizeId(sandboxId)}-${port}`;

// Session names split out of a `list` listing, narrowed to the ones this agent owns. Whitespace-separated is
// unambiguous because a name is a sanitized id (plus a port number for a forward), and anything outside our
// prefix belongs to the user's own Mutagen — never ours to terminate.
const oursIn = (listed: string, prefix: string): string[] => listed.split(/\s+/).filter((name) => name.startsWith(prefix));

// The sandbox a forward session belongs to. The port is the trailing all-digit segment, so a sanitized id
// containing dashes (every real one does) still splits off correctly.
const FORWARD_NAME = new RegExp(`^${FORWARD_PREFIX}(.+)-(\\d+)$`);

// Our forward sessions, optionally narrowed to ONE sandbox — what lets a single pairing be torn down without
// touching the forwards every other paired sandbox on this machine is holding. Matching parses the name instead
// of testing a prefix: `intentic-fwd-sandbox-a-` is a prefix of `intentic-fwd-sandbox-a-b-5173` too.
export const parseForwardNames = (listed: string, sandboxId?: string): string[] => {
    const names = oursIn(listed, FORWARD_PREFIX);
    if (sandboxId === undefined) {
        return names;
    }
    const wanted = sanitizeId(sandboxId);
    return names.filter((name) => FORWARD_NAME.exec(name)?.[1] === wanted);
};

// Forward sessions belonging to no pairing we still hold: a sandbox that was unpaired (or whose config was lost)
// while Mutagen kept its localhost listener bound. Verified against 0.18.1: a session whose sandbox has been
// destroyed still reports ForwardingConnections and still holds the port, so every port it used greets the next
// pairing as "busy on this machine" until something terminates it.
export const parseOrphanForwardNames = (listed: string, keptSandboxIds: readonly string[]): string[] => {
    const kept = new Set(keptSandboxIds.map(sanitizeId));
    return parseForwardNames(listed).filter((name) => {
        const owner = FORWARD_NAME.exec(name)?.[1];
        return owner === undefined || !kept.has(owner);
    });
};

// Which file-sync sessions to retire: ours, minus the ones the pairings we still hold name. A session is retired
// because NOTHING claims it any more — never merely because another pairing arrived. Mutagen retries a
// disconnected session every 15 seconds for as long as the daemon lives, so an orphan is a dead sandbox being
// dialled forever and a line of junk in `intentic-sync status`.
// Forward sessions carry the same prefix but never appear in a `sync list`, so they can't be caught here.
export const parseOrphanSyncNames = (listed: string, keep: readonly string[]): string[] => {
    const kept = new Set(keep);
    return oursIn(listed, SESSION_PREFIX).filter((name) => !kept.has(name));
};

// The raw name listing for one kind of session. A daemon that isn't running (or a list that fails) has nothing
// of ours to report — and nothing to tear down either.
const listSessionNames = (mutagen: string, kind: "forward" | "sync"): string => {
    const result = spawnSync(mutagen, [kind, "list", "--template", "{{range .}}{{.Name}} {{end}}"], { encoding: "utf8" });
    return result.status === 0 ? result.stdout : "";
};

// Every forward session in the daemon that is ours — all of them, or just one sandbox's.
export const ourForwardSessions = (mutagen: string, sandboxId?: string): string[] =>
    parseForwardNames(listSessionNames(mutagen, "forward"), sandboxId);

// Forward sessions no pairing in `keptSandboxIds` claims.
export const orphanForwardSessions = (mutagen: string, keptSandboxIds: readonly string[]): string[] =>
    parseOrphanForwardNames(listSessionNames(mutagen, "forward"), keptSandboxIds);

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

// The session for a pairing: name and ssh alias both namespace on the sandbox id, and the remote side is always
// /work — the sandbox's workspace root is the only thing there is to sync.
const sessionSpec = (pairing: Pairing & { readonly localDir: string }): SyncSessionSpec => ({
    name: sessionName(pairing.sandboxId),
    localDir: pairing.localDir,
    alias: sshAlias(pairing.sandboxId),
    remoteDir: "/work",
});

// `mutagen sync create` args: two-way-safe (flags conflicts rather than clobber), our ignore set, and
// neighboring staging on the remote so a huge file stages on the same filesystem as /work (atomic rename, no
// cross-fs 2× copy). local first, then user@alias:/work. The sync mode is pinned explicitly — Mutagen's default
// is two-way-safe, but relying on the default lets a version bump or a user's global mutagen config silently
// switch it to a clobbering mode; pinning keeps conflicts flagged, never overwritten.
//
// No --ignore-vcs: its pattern set covers .git DIRECTORIES only, and the shapes that actually appear here —
// the pointer FILES the daemon leaves at /work/.git and inside every relocated repo — slip straight through
// it. IGNORES carries the bare `.git` that covers every shape at every level; see the comment there. Git
// state travels by git's own protocol instead (git-bridge.ts).
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

// A live session as the daemon reports it, narrowed to what the drift check and the status report read. Protobuf
// JSON omits defaults, so a session with no ignores at all arrives as `"ignore":{}` and vcs:false is simply
// absent — and by the same rule `status`/`conflicts` are absent on a session that has neither, which is why
// everything the report reads is optional rather than defaulted here.
interface LiveSession {
    readonly alpha: { readonly path?: string };
    readonly beta: { readonly host?: string; readonly path?: string };
    readonly ignore: { readonly paths?: readonly string[]; readonly vcs?: boolean };
    readonly paused?: boolean;
    readonly status?: string;
    readonly conflicts?: readonly unknown[];
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

/* What one pairing's file sync is DOING right now, for the machine report. Mutagen's own word is carried through
 * rather than mapped onto a traffic light: its halted states name their own cause ("halted-on-root-emptied"), and
 * a UI that flattens them to "problem" sends the user back to the terminal the report exists to replace.
 *
 * Every field is absent when Mutagen did not say — a session that has never run, a daemon that is not up, a
 * version whose JSON does not carry it. Absent must read as "not known", never as zero conflicts. */
export const readSessionState = (
    mutagen: string,
    name: string,
): { status?: string | undefined; paused?: boolean | undefined; conflicts?: number | undefined } => {
    const session = readSession(mutagen, name);
    if (session === undefined) {
        return {};
    }
    return { status: session.status, paused: session.paused, conflicts: session.conflicts?.length };
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
export const ensureSyncSession = (mutagen: string, pairing: Pairing, log: Log): void => {
    if (pairing.mode !== "sync" || pairing.localDir === undefined) {
        return; // a mirror-only enrollment has no file sync at all — just port forwards
    }
    const spec = sessionSpec({ ...pairing, localDir: pairing.localDir });
    const live = readSession(mutagen, spec.name);
    if (live !== undefined && sessionMatchesSpec(live, spec)) {
        return;
    }
    if (live !== undefined) {
        log(
            "the running sync session was created by an older agent — recreating it so this version's rules apply (no .git file-syncs anymore; commits arrive via the git bridge instead).",
        );
        spawnSync(mutagen, ["sync", "terminate", spec.name], { stdio: "ignore" });
    }
    runMutagen(mutagen, mutagenCreateArgs(spec, live?.paused === true));
};

// Sweep the file-sync and forward sessions no pairing claims any more. Run when the pairing list changes, so an
// unpaired sandbox stops being dialled and releases the localhost ports it was holding — WITHOUT this being the
// thing that fires when a second sandbox is merely added, which is how a live pairing used to get evicted.
export const retireOrphanSessions = (mutagen: string, pairings: readonly Pairing[], log: Log): void => {
    const ids = pairings.map((pairing) => pairing.sandboxId);
    const sessions = parseOrphanSyncNames(
        listSessionNames(mutagen, "sync"),
        pairings.map((pairing) => sessionName(pairing.sandboxId)),
    );
    if (sessions.length > 0) {
        spawnSync(mutagen, ["sync", "terminate", ...sessions], { stdio: "ignore" });
        log(`retired ${sessions.length} file-sync session(s) belonging to sandboxes this machine no longer pairs.`);
    }
    const forwards = orphanForwardSessions(mutagen, ids);
    if (forwards.length > 0) {
        spawnSync(mutagen, ["forward", "terminate", ...forwards], { stdio: "ignore" });
        log(`released ${forwards.length} port forward(s) left holding localhost for sandboxes this machine no longer pairs.`);
    }
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

// The version an installed copy reports — undefined when there is none, or when it is broken or half-extracted.
// Both tools print a semver we can read (`mutagen version` → "0.18.1", `cloudflared --version` → "cloudflared
// version 2026.7.2 (built …)") and both are PINNED above, so this one question decides whether anything needs
// downloading at all. Asking it matters more than the bandwidth it saves: re-extracting over a copy whose
// process is resident cannot succeed on Windows, where a running executable can be neither unlinked nor
// overwritten ("mutagen.exe: Can't unlink already-existing object: Permission denied"), so once the first setup
// had started the daemon, every later command that needed Mutagen — status, pause, a second setup — died there.
const installedVersion = (binary: string, versionArgs: string[]): string | undefined => {
    const result = spawnSync(binary, versionArgs, { encoding: "utf8" });
    if (result.error !== undefined || result.status !== 0) {
        return undefined;
    }
    return /\d+\.\d+\.\d+/.exec(result.stdout)?.[0];
};

const download = async (url: string, dest: string): Promise<void> => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`download failed (${response.status}): ${url}`);
    }
    await mkdir(binDir, { recursive: true });
    await writeFile(dest, new Uint8Array(await response.arrayBuffer()));
};

// Put whatever `write` produces at `binary` in place of what is there now. Windows refuses to unlink or
// overwrite a RUNNING executable — the Mutagen daemon and the cloudflared processes ssh keeps alive each hold
// their own image open — but it does allow RENAMING one, which leaves the live process running from the
// renamed file while the replacement takes its place. (sync.ps1 does exactly this for the agent's own binary.)
// The displaced copy is swept at both ends, so it survives only while something is still executing it.
const replaceBinary = async (binary: string, write: () => Promise<void> | void): Promise<void> => {
    const displaced = `${binary}.old`;
    // Best-effort: a leftover that cannot go yet is still being run, and the write below is what has to succeed.
    await rm(displaced, { force: true }).catch(() => {});
    await rename(binary, displaced).catch(() => {});
    await write();
    await chmod(binary, 0o755);
    await rm(displaced, { force: true }).catch(() => {});
};

// Extract a gzipped tarball into ~/.intentic/sync/bin using the system `tar` (bsdtar on macOS/Windows 10+).
const extractTarball = (tarball: string): void => {
    const extract = spawnSync("tar", ["-xzf", tarball, "-C", binDir], { stdio: "inherit" });
    if (extract.status !== 0) {
        throw new Error(`failed to extract ${tarball} — tar's own reason is above (no \`tar\` on PATH, or a file it must replace is in use)`);
    }
};

// Resolve cloudflared: the user's own install if they have one, else our pinned copy in ~/.intentic/sync/bin,
// downloaded only when what is there isn't already the pin. Asset shapes differ per OS: bare binary on linux,
// .tgz on darwin, .exe on windows (amd64 only — no windows-arm64 build exists).
export const ensureCloudflared = async (): Promise<string> => {
    if (installedVersion("cloudflared", ["--version"]) !== undefined) {
        return "cloudflared";
    }
    const dest = join(binDir, `cloudflared${exe}`);
    if (installedVersion(dest, ["--version"]) === CLOUDFLARED_VERSION) {
        return dest;
    }
    const os = osToken();
    const base = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;
    const assetUrl = (): string => {
        if (os === "darwin") {
            return `${base}/cloudflared-darwin-${archToken()}.tgz`;
        }
        if (os === "windows") {
            if (archToken() !== "amd64") {
                throw new Error("cloudflared has no windows-arm64 build — install cloudflared manually, then re-run.");
            }
            return `${base}/cloudflared-windows-amd64.exe`;
        }
        return `${base}/cloudflared-linux-${archToken()}`;
    };
    // The download lands BESIDE the target and only then takes its place: a half-download never becomes the
    // binary, and the copy being replaced stays runnable until the new bytes are on disk.
    const staged = join(binDir, os === "darwin" ? "cloudflared.tgz" : `cloudflared${exe}.new`);
    await download(assetUrl(), staged);
    await replaceBinary(dest, () => (os === "darwin" ? extractTarball(staged) : rename(staged, dest)));
    return dest;
};

// Resolve mutagen: the user's own install if they have one (at whatever version they run it at), else our
// pinned copy — downloaded and extracted (binary + agent bundle side by side, as Mutagen requires) only when
// what is in ~/.intentic/sync/bin isn't already the pin.
export const ensureMutagen = async (): Promise<string> => {
    if (installedVersion("mutagen", ["version"]) !== undefined) {
        return "mutagen";
    }
    const dest = join(binDir, `mutagen${exe}`);
    if (installedVersion(dest, ["version"]) === MUTAGEN_VERSION) {
        return dest;
    }
    // Replacing our copy retires the daemon running FROM it — a daemon of another version never serves this
    // CLI anyway, and on Windows it is precisely what holds the file open. Best-effort: usually there is none.
    spawnSync(dest, ["daemon", "stop"], { stdio: "ignore" });
    const tarball = join(binDir, "mutagen.tar.gz");
    await download(
        `https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/mutagen_${osToken()}_${archToken()}_v${MUTAGEN_VERSION}.tar.gz`,
        tarball,
    );
    await replaceBinary(dest, () => extractTarball(tarball));
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
