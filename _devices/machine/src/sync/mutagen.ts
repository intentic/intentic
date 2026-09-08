import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { DeviceConflict, DeviceConflictChange } from "@intentic/sandbox-contract";
import {
    type CliLauncher,
    clearWindowsRunValue,
    type Log,
    quotedCommandLine,
    setWindowsRunValue,
    stubCommand,
    windowsLaunchStub,
} from "@intentic/local-agent";
import { binDir, mutagenDaemonLogPath, type Pairing } from "./config.js";
import { runProcess } from "./exec.js";
import { BACKUP_IGNORES, IGNORES, mutagenSshPath, sanitizeId, sshAlias, sshTransportAnswers } from "./ssh.js";

// The pinned Mutagen version this agent downloads when the machine has no install of its own.
const MUTAGEN_VERSION = "0.18.1";

// Prefix every session this agent creates carries, sync and forward alike, so they're all findable again.
const SESSION_PREFIX = "intentic-";

// The Mutagen session name (letters/digits/dashes) that `sync list/pause/resume/terminate` target.
export const sessionName = (sandboxId: string): string => `${SESSION_PREFIX}${sanitizeId(sandboxId)}`;

// The backup session's name, carrying the sandbox's state dir one-way. Hangs off the workspace session's name
// rather than its own prefix, so prefix-based sweeps (oursIn, parseOrphanSyncNames) still find it.
export const backupSessionName = (sandboxId: string): string => `${sessionName(sandboxId)}-state`;

// Both of a pairing's sync sessions, workspace then backup; pause, resume, terminate and the orphan sweep all act
// on both names together.
export const syncSessionNames = (sandboxId: string): readonly string[] => [sessionName(sandboxId), backupSessionName(sandboxId)];

// One forward session per port, deterministically named so reconcile can target it without querying Mutagen's
// session list. The name carries the sandbox id, so a session outlives the config that could name it.
const FORWARD_PREFIX = "intentic-fwd-";
export const forwardSessionName = (sandboxId: string, port: number): string => `${FORWARD_PREFIX}${sanitizeId(sandboxId)}-${port}`;

// Session names from a `list` listing, narrowed to this agent's prefix; anything else is the user's own Mutagen,
// never ours to terminate.
const oursIn = (listed: string, prefix: string): string[] => listed.split(/\s+/).filter((name) => name.startsWith(prefix));

// Parses the sandbox id off a forward name by its trailing digit port, immune to dashes in the id.
const FORWARD_NAME = new RegExp(`^${FORWARD_PREFIX}(.+)-(\\d+)$`);

// This agent's forward sessions, optionally narrowed to one sandbox. Parses the name rather than testing a
// prefix, since `intentic-fwd-sandbox-a-` is itself a prefix of `intentic-fwd-sandbox-a-b-5173`.
export const parseForwardNames = (listed: string, sandboxId?: string): string[] => {
    const names = oursIn(listed, FORWARD_PREFIX);
    if (sandboxId === undefined) {
        return names;
    }
    const wanted = sanitizeId(sandboxId);
    return names.filter((name) => FORWARD_NAME.exec(name)?.[1] === wanted);
};

// Forward sessions belonging to no pairing still held: Mutagen keeps a forward's listener bound after its sandbox
// is gone, so its port reads as busy until something terminates it.
export const parseOrphanForwardNames = (listed: string, keptSandboxIds: readonly string[]): string[] => {
    const kept = new Set(keptSandboxIds.map(sanitizeId));
    return parseForwardNames(listed).filter((name) => {
        const owner = FORWARD_NAME.exec(name)?.[1];
        return owner === undefined || !kept.has(owner);
    });
};

// This agent's file-sync sessions minus the ones still held; retired only when nothing claims them, never merely
// because another pairing arrived. Forward sessions share the prefix but never appear in `sync list`, so they aren't
// caught here.
export const parseOrphanSyncNames = (listed: string, keep: readonly string[]): string[] => {
    const kept = new Set(keep);
    return oursIn(listed, SESSION_PREFIX).filter((name) => !kept.has(name));
};

// Raw name listing for one session kind; a dead daemon or failed list reports nothing to tear down.
const listSessionNames = (mutagen: string, kind: "forward" | "sync"): string => {
    const result = spawnSync(mutagen, [kind, "list", "--template", "{{range .}}{{.Name}} {{end}}"], { encoding: "utf8", windowsHide: true });
    return result.status === 0 ? result.stdout : "";
};

// Every forward session in the daemon that is ours, all of them, or just one sandbox's.
export const ourForwardSessions = (mutagen: string, sandboxId?: string): string[] =>
    parseForwardNames(listSessionNames(mutagen, "forward"), sandboxId);

// Forward sessions no pairing in `keptSandboxIds` claims.
const orphanForwardSessions = (mutagen: string, keptSandboxIds: readonly string[]): string[] =>
    parseOrphanForwardNames(listSessionNames(mutagen, "forward"), keptSandboxIds);

// Binds the same local port and pipes it to the sandbox's recorded loopback address; `host` matters because a
// `localhost` bind inside the sandbox can land on ::1 only (Vite), where 127.0.0.1 is refused.
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

// Everything a file-sync session is made of: the two endpoints plus the findable name. One shape describes both
// what to create and what a live session is compared against.
export interface SyncSessionSpec {
    readonly name: string;
    readonly localDir: string;
    readonly alias: string;
    readonly remoteDir: string;
    // Two-way for the both-edited workspace; one-way replica for the backup, whose only writer is the sandbox.
    readonly mode: "two-way-safe" | "one-way-replica";
    readonly ignores: readonly string[];
    // Which end is alpha: Mutagen's one-way modes always propagate alpha→beta, so the backup must put the sandbox
    // first. Getting this backwards would not fail loudly, it would silently overwrite the sandbox's state with the
    // laptop's.
    readonly from: "local" | "sandbox";
}

// The workspace session for a pairing: name and alias namespace on the sandbox id; remote side is always /work.
const sessionSpec = (pairing: Pairing & { readonly localDir: string }): SyncSessionSpec => ({
    name: sessionName(pairing.sandboxId),
    localDir: pairing.localDir,
    alias: sshAlias(pairing.sandboxId),
    remoteDir: WORKSPACE_ROOT,
    mode: "two-way-safe",
    ignores: IGNORES,
    from: "local",
});

// Mirrors the sandbox's state dir into `<localDir>/.intentic`, one-way, sandbox first — the daemon is the only
// writer. Halts rather than emptying beta when alpha's root disappears, so a mid-rebuild sandbox isn't read as a
// deleted backup.
const backupSpec = (pairing: Pairing & { readonly localDir: string }): SyncSessionSpec => ({
    name: backupSessionName(pairing.sandboxId),
    localDir: join(pairing.localDir, STATE_DIR),
    alias: sshAlias(pairing.sandboxId),
    remoteDir: `${WORKSPACE_ROOT}/${STATE_DIR}`,
    mode: "one-way-replica",
    ignores: BACKUP_IGNORES,
    from: "sandbox",
});

// Two-way-safe is pinned explicitly, so a version bump or global config can't silently switch it to clobbering.
// No --ignore-vcs: it misses the pointer-file .git this layout leaves; IGNORES' bare `.git` covers that instead.
export const mutagenCreateArgs = (spec: SyncSessionSpec, paused: boolean): string[] => {
    const local = spec.localDir;
    const remote = `${spec.alias}:${spec.remoteDir}`;
    return [
        "sync",
        "create",
        "--name",
        spec.name,
        "--sync-mode",
        spec.mode,
        ...(paused ? ["--paused"] : []),
        ...spec.ignores.flatMap((pattern) => ["--ignore", pattern]),
        "--stage-mode-beta",
        "neighboring",
        // `from` decides which endpoint is alpha, since direction is endpoint order for a one-way session.
        ...(spec.from === "local" ? [local, remote] : [remote, local]),
    ];
};

// What the drift check and report read off a live session. Protobuf JSON omits defaults, so absent here can mean
// the zero value, not unknown; every field stays optional rather than defaulted.

// One side's edit to a path (change.proto): `old`/`new` presence is the whole message, absent old means created,
// absent new means deleted. Both stay `unknown`; only presence is read.
interface LiveChange {
    readonly path?: string;
    readonly old?: unknown;
    readonly new?: unknown;
}

// A conflicted path plus its colliding changes; `root` is the session-relative path from conflict.proto.
interface LiveConflict {
    readonly root?: string;
    readonly alphaChanges?: readonly LiveChange[];
    readonly betaChanges?: readonly LiveChange[];
}

interface LiveSession {
    // Both ends carry an optional host since a session may run either way (the backup's alpha is the sandbox);
    // protobuf omits a local endpoint's host, so undefined means "this machine".
    readonly alpha: { readonly host?: string; readonly path?: string };
    readonly beta: { readonly host?: string; readonly path?: string };
    readonly ignore: { readonly paths?: readonly string[]; readonly vcs?: boolean };
    readonly paused?: boolean;
    readonly status?: string;
    readonly conflicts?: readonly LiveConflict[];
    // Conflicts left out of the list above; the list is capped for display, never the true count.
    readonly excludedConflicts?: number;
}

// The session of this name, or undefined if none: a non-zero exit is Mutagen's "no match" or an unreachable
// daemon, and the create that follows fails loudly with the real reason.
const readSession = (mutagen: string, name: string): LiveSession | undefined => {
    const result = spawnSync(mutagen, ["sync", "list", "--template", "{{json .}}", name], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) {
        return undefined;
    }
    return (JSON.parse(result.stdout) as LiveSession[])[0];
};

// Two-way-safe flags conflicts by path, not just a count; alpha is always this device (workspace session is
// created local-first). Mutagen truncates the list it reports, so the count is the true total and paths are capped
// again here.
export const CONFLICT_PATHS_MAX = 24;

// Created, deleted, or modified, from which side of a change is present; neither present says nothing rather
// than guessing.
const changeKind = (change: LiveChange | undefined): DeviceConflictChange | undefined => {
    if (change === undefined) {
        return undefined;
    }
    const before = change.old !== undefined && change.old !== null;
    const after = change.new !== undefined && change.new !== null;
    if (!before) {
        return after ? "created" : undefined;
    }
    return after ? "modified" : "deleted";
};

// The change about the conflicted path if any; a directory-rooted conflict carries changes underneath it, so the
// first one is the closest honest match.
const sideChange = (changes: readonly LiveChange[] | undefined, root: string): LiveChange | undefined =>
    changes?.find((change) => (change.path ?? "") === root) ?? changes?.[0];

const conflictedPath = (conflict: LiveConflict): DeviceConflict => {
    // An empty root is the synced folder itself; a change's path is the fallback when the conflict carried none.
    const path = conflict.root ?? sideChange(conflict.alphaChanges, "")?.path ?? sideChange(conflict.betaChanges, "")?.path ?? "";
    const local = changeKind(sideChange(conflict.alphaChanges, path));
    const sandbox = changeKind(sideChange(conflict.betaChanges, path));
    return { path, ...(local === undefined ? {} : { local }), ...(sandbox === undefined ? {} : { sandbox }) };
};

export const conflictsFrom = (session: Pick<LiveSession, "conflicts" | "excludedConflicts">): { count: number; paths: DeviceConflict[] } | undefined => {
    const listed = session.conflicts ?? [];
    const excluded = Number(session.excludedConflicts ?? 0);
    const count = listed.length + (Number.isFinite(excluded) ? excluded : 0);
    // Absent means "none reported", not zero; never interpolated into a sentence about what's wrong.
    return count === 0 ? undefined : { count, paths: listed.slice(0, CONFLICT_PATHS_MAX).map(conflictedPath) };
};

// Keeps Mutagen's status word instead of a traffic light; halted states name their own cause. `exists` is
// separate from `status` since protobuf omits the zero value ("disconnected"), which would else look like no session.
export const readSessionState = (
    mutagen: string,
    name: string,
): {
    exists: boolean;
    status?: string | undefined;
    paused?: boolean | undefined;
    conflicts?: number | undefined;
    conflictedPaths?: DeviceConflict[] | undefined;
} => {
    const session = readSession(mutagen, name);
    if (session === undefined) {
        return { exists: false };
    }
    const conflicts = conflictsFrom(session);
    // An omitted status is the enum's zero value, which is Mutagen's own "disconnected", named rather than dropped.
    return {
        exists: true,
        status: session.status ?? "disconnected",
        paused: session.paused,
        conflicts: conflicts?.count,
        conflictedPaths: conflicts?.paths,
    };
};

// Which of these session names the daemon actually has. `sync list a b` is all-or-nothing, one unresolved name
// fails the whole call, so callers ask this first and name the rest themselves.
export const existingSyncSessions = (mutagen: string, names: readonly string[]): string[] => {
    const listed = new Set(oursIn(listSessionNames(mutagen, "sync"), SESSION_PREFIX));
    return names.filter((name) => listed.has(name));
};

// Pauses a sandbox unreachable for an hour, without touching a deliberate manual pause. Both sessions
// pause/resume as a pair; already-idle or already-paused pairings are left alone.
export const pauseUnreachableSync = (mutagen: string, pairing: Pairing): boolean => {
    if (pairing.mode !== "sync") {
        return false;
    }
    const names = existingSyncSessions(mutagen, syncSessionNames(pairing.sandboxId));
    // `every` over an empty list is true, so "no sessions" and "all paused" share the branch on purpose.
    if (names.every((name) => readSessionState(mutagen, name).paused === true)) {
        return false;
    }
    const result = spawnSync(mutagen, ["sync", "pause", ...names], { stdio: "ignore", windowsHide: true });
    return result.status === 0;
};

export const resumeAutoPausedSync = (mutagen: string, pairing: Pairing): boolean => {
    if (pairing.mode !== "sync" || pairing.fileSyncAutoPaused !== true) {
        return false;
    }
    const names = existingSyncSessions(mutagen, syncSessionNames(pairing.sandboxId));
    if (names.length === 0) {
        return false;
    }
    const result = spawnSync(mutagen, ["sync", "resume", ...names], { stdio: "ignore", windowsHide: true });
    return result.status === 0;
};

// Whether the running session is what this build would create. Mutagen freezes config at `sync create` with no
// edit verb, so a stale ignore list means a session that will never behave like this version says.
export const sessionMatchesSpec = (session: LiveSession, spec: SyncSessionSpec): boolean => {
    // Which endpoint should hold what for this spec's direction; a backup with reversed ends must never read as
    // "close enough" — it would upload instead of download.
    const [alpha, beta] =
        spec.from === "local"
            ? [
                  { host: undefined, path: spec.localDir },
                  { host: spec.alias, path: spec.remoteDir },
              ]
            : [
                  { host: spec.alias, path: spec.remoteDir },
                  { host: undefined, path: spec.localDir },
              ];
    return (
        session.alpha.path === alpha.path &&
        session.alpha.host === alpha.host &&
        session.beta.path === beta.path &&
        session.beta.host === beta.host &&
        session.ignore.vcs !== true &&
        (session.ignore.paths ?? []).join("\n") === spec.ignores.join("\n")
    );
};

// Converges the session to this build's spec: creates if missing, recreates if drifted, since recreating is the
// only way to change ignores. Cheap when content already matches (a rescan, not a re-download); a paused session stays
// paused.
export const ensureSyncSession = async (mutagen: string, pairing: Pairing, log: Log): Promise<void> => {
    if (pairing.mode !== "sync" || pairing.localDir === undefined) {
        return; // a mirror-only enrollment has no file sync at all: just port forwards
    }
    const held = { ...pairing, localDir: pairing.localDir };
    // Both sessions, converged in order, sequential since they share one ssh transport and daemon; workspace first
    // since that's what the user is waiting on. An unreachable sandbox leaves both alone, never half-converged.
    for (const spec of [sessionSpec(held), backupSpec(held)]) {
        await convergeSession(mutagen, spec, log);
    }
};

const convergeSession = async (mutagen: string, spec: SyncSessionSpec, log: Log): Promise<void> => {
    const live = readSession(mutagen, spec.name);
    if (live !== undefined && sessionMatchesSpec(live, spec)) {
        return;
    }
    if (live !== undefined) {
        // Never tears down a session it can't replace: `sync create` needs the sandbox to answer, so the transport is
        // probed first, and an unreachable sandbox keeps its drifted session (retried next pass) rather than losing
        // sync entirely.
        if (!(await sshTransportAnswers(mutagenSshPath(process.platform, process.env["MUTAGEN_SSH_PATH"]), spec.alias))) {
            log(
                `${spec.name}: the sandbox is not answering, so its existing file sync is left running as it is rather than terminated for a replacement that cannot be created. Retrying later.`,
            );
            return;
        }
        log(
            "the running sync session does not match this build's spec: recreating it so the current rules apply (no .git file-syncs; commits arrive via the git bridge instead).",
        );
        spawnSync(mutagen, ["sync", "terminate", spec.name], { stdio: "ignore", windowsHide: true });
    }
    await runMutagenAsync(mutagen, mutagenCreateArgs(spec, live?.paused === true), log);
};

// Sweeps file-sync and forward sessions no pairing claims any more, so an unpaired sandbox stops being dialled
// and releases its ports. Must never fire merely because another sandbox was added.
export const retireOrphanSessions = (mutagen: string, pairings: readonly Pairing[], log: Log): void => {
    const ids = pairings.map((pairing) => pairing.sandboxId);
    const sessions = parseOrphanSyncNames(
        listSessionNames(mutagen, "sync"),
        pairings.flatMap((pairing) => syncSessionNames(pairing.sandboxId)),
    );
    if (sessions.length > 0) {
        spawnSync(mutagen, ["sync", "terminate", ...sessions], { stdio: "ignore", windowsHide: true });
        log(`retired ${sessions.length} file-sync session(s) belonging to sandboxes this machine no longer pairs.`);
    }
    const forwards = orphanForwardSessions(mutagen, ids);
    if (forwards.length > 0) {
        spawnSync(mutagen, ["forward", "terminate", ...forwards], { stdio: "ignore", windowsHide: true });
        log(`released ${forwards.length} port forward(s) left holding localhost for sandboxes this machine no longer pairs.`);
    }
};

export const osToken = (): "linux" | "darwin" | "windows" => {
    if (process.platform === "linux" || process.platform === "darwin") {
        return process.platform;
    }
    if (process.platform === "win32") {
        return "windows";
    }
    throw new Error(`auto-download isn't supported on ${process.platform}: install mutagen and cloudflared manually, then re-run.`);
};

export const exe = process.platform === "win32" ? ".exe" : "";

export const archToken = (): "amd64" | "arm64" => {
    if (process.arch === "x64") {
        return "amd64";
    }
    if (process.arch === "arm64") {
        return "arm64";
    }
    throw new Error(`unsupported CPU arch ${process.arch}: install mutagen and cloudflared manually, then re-run.`);
};

// The installed version, or undefined if missing/broken. Matters most on Windows, where a resident daemon's
// binary can be neither unlinked nor overwritten, so checking first avoids re-extracting over it.
const installedVersion = (binary: string, versionArgs: string[]): string | undefined => {
    const result = spawnSync(binary, versionArgs, { encoding: "utf8", windowsHide: true });
    if (result.error !== undefined || result.status !== 0) {
        return undefined;
    }
    return /\d+\.\d+\.\d+/.exec(result.stdout)?.[0];
};

// What a download may do beyond arriving, both off by default: resume needs a destination name that means one
// set of bytes (true for the agent's staged file, not Mutagen's tarball), and progress needs somewhere to show it.
interface DownloadOptions {
    /** Continue whatever is already at `dest` instead of starting again. */
    readonly resume?: boolean;
    /** Bytes so far and the total when the other end states one, called per chunk. */
    readonly onProgress?: (received: number, total: number) => void;
}

// Streams to disk with backpressure rather than buffering the whole body in memory. A failure mid-flight leaves
// the part file in place for the next attempt to resume from; `resume` is the caller's decision.
// What is already at a path; zero for anything unaskable (free name, directory, permission), the safe "nothing
// to continue" answer.
const fileSize = async (path: string): Promise<number> => {
    try {
        return (await stat(path)).size;
    } catch {
        return 0;
    }
};

// Where the next byte comes from, given what's already on disk:
// 416 - range past the end; caller decides what that means.
// 206 - range honoured; body continues the file.
// 200 - range ignored; body is the whole file, so the part file must be truncated.
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
    // A 206 without a length reports total as zero, never `have`, or a half-finished download would look complete.
    const length = Number(response.headers.get("content-length") ?? 0);
    return { body: response.body, total: length > 0 ? (appending ? have + length : length) : 0, appending };
};

// The transfer itself: one read at a time, written with backpressure rather than queued in memory. Split out so
// the decisions above stay readable, and because its failure must leave the part file where it is.
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

// Replaces `binary` with what `write` produces. Windows refuses to unlink or overwrite a running executable but
// allows renaming one, so the live process keeps running from the renamed file while the replacement takes its place.
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
    const extract = spawnSync("tar", ["-xzf", tarball, "-C", binDir], { stdio: "inherit", windowsHide: true });
    if (extract.status !== 0) {
        throw new Error(`failed to extract ${tarball}: tar's own reason is above (no \`tar\` on PATH, or a file it must replace is in use)`);
    }
};

// Resolves mutagen: the user's own install if present, else the pinned copy, downloaded and extracted only when
// ~/.intentic/sync/bin isn't already at that version.
export const ensureMutagen = async (): Promise<string> => {
    if (installedVersion("mutagen", ["version"]) !== undefined) {
        return "mutagen";
    }
    const dest = join(binDir, `mutagen${exe}`);
    if (installedVersion(dest, ["version"]) === MUTAGEN_VERSION) {
        return dest;
    }
    // Stops any daemon from our copy first; on Windows that's what holds the file open. Best-effort.
    spawnSync(dest, ["daemon", "stop"], { stdio: "ignore", windowsHide: true });
    const tarball = join(binDir, "mutagen.tar.gz");
    await download(
        `https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/mutagen_${osToken()}_${archToken()}_v${MUTAGEN_VERSION}.tar.gz`,
        tarball,
    );
    await replaceBinary(dest, () => extractTarball(tarball));
    return dest;
};

// Runs without blocking, for anything that dials a sandbox (sync/forward create): the watcher serves the SSH
// transport those commands ride, so a blocking spawn would deadlock it (exec.ts). Throws on failure like its blocking
// twin.
export const runMutagenAsync = async (mutagen: string, args: readonly string[], log: Log): Promise<void> => {
    const result = await runProcess(mutagen, args);
    const said = `${result.stdout}${result.stderr}`.trim();
    if (result.status === 0) {
        return;
    }
    if (said !== "") {
        log(`  mutagen: ${said.split("\n").join(" / ")}`);
    }
    throw new Error(`mutagen ${args[0] ?? ""} exited with code ${result.status}`);
};

// Runs a mutagen subcommand, inheriting stdio, throwing on failure. One-shot CLI commands only, never the
// resident watcher.
export const runMutagen = (mutagen: string, args: string[]): SpawnSyncReturns<Buffer> => {
    const result = spawnSync(mutagen, args, { stdio: "inherit", windowsHide: true });
    if (result.error !== undefined) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`mutagen ${args[0] ?? ""} exited with code ${result.status}`);
    }
    return result;
};

// This agent's own Windows Run value for Mutagen's daemon, distinct from Mutagen's own `Mutagen` key, so
// uninstalling this agent doesn't touch a user's own registration.
export const MUTAGEN_RUN_VALUE = "IntenticMutagenDaemon";

// Registers Mutagen's daemon to survive reboot; on Windows, `daemon start` opens a console window unless run
// through our stub launcher. Unregisters first so two registrations can't coexist; Linux has no register verb.
export const registerMutagenAutostart = (mutagen: string, launcher: CliLauncher, log: Log): void => {
    if (process.platform === "linux") {
        return;
    }
    try {
        const stub = windowsLaunchStub(launcher);
        if (stub === undefined) {
            runMutagen(mutagen, ["daemon", "register"]);
            return;
        }
        spawnSync(mutagen, ["daemon", "unregister"], { stdio: "ignore", windowsHide: true });
        setWindowsRunValue(MUTAGEN_RUN_VALUE, quotedCommandLine(stubCommand(stub, mutagenDaemonLogPath, [mutagen, "daemon", "start"])));
    } catch (error) {
        log(`note: could not register the Mutagen daemon for autostart (${errorMessage(error)}); it still runs while you're logged in.`);
    }
};

// Clears both spellings unconditionally: which one got registered depends on what this machine could do at the
// time, and leaving the other behind resurrects the daemon at next login.
export const unregisterMutagenAutostart = (mutagen: string): void => {
    if (process.platform === "win32") {
        clearWindowsRunValue(MUTAGEN_RUN_VALUE);
    }
    if (process.platform !== "linux") {
        spawnSync(mutagen, ["daemon", "unregister"], { stdio: "ignore", windowsHide: true });
    }
};
