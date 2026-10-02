import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { DeviceConflict, DeviceConflictChange, DeviceConflictNature } from "@intentic/sandbox-contract";
import {
    type CliLauncher,
    clearWindowsRunValue,
    type Log,
    quotedCommandLine,
    setWindowsRunValue,
    stubCommand,
    windowsLaunchStub,
} from "@intentic/local-agent";
import { binDir } from "../config.js";
import { archToken, download, exe, osToken, renameIfPresent } from "../release.js";
import { isProjectPairing, mutagenDaemonLogPath, type Pairing, pairingRemoteDir, projectDirection } from "./config.js";
import { dockerEndpointAnswers, liveIdentity, mutagenForwardUrl, mutagenUrl, pairingEndpoint, type SandboxEndpoint } from "./endpoint.js";
import { runProcess } from "./exec.js";
import { clearConflictResidue, type ResidueOutcome, sweepDerivedResidue } from "./residue.js";
import { BACKUP_IGNORES, ignoresFor, mutagenSshPath, sanitizeId, sshTransportAnswers } from "./ssh.js";
import { deviceSymlinks, type SymlinkMode } from "./symlinks.js";

// The pinned Mutagen version this agent downloads when the machine has no install of its own.
const MUTAGEN_VERSION = "0.18.1";

// Prefix every session this agent creates carries, sync and forward alike, so they're all findable again.
const SESSION_PREFIX = "intentic-";

// The Mutagen session name (letters/digits/dashes) that `sync list/pause/resume/terminate` target.
export const sessionName = (sandboxId: string): string => `${SESSION_PREFIX}${sanitizeId(sandboxId)}`;

// The backup session's name, carrying the sandbox's state dir one-way. Hangs off the workspace session's name
// rather than its own prefix, so prefix-based sweeps (oursIn, parseOrphanSyncNames) still find it.
export const backupSessionName = (sandboxId: string): string => `${sessionName(sandboxId)}-state`;

// A pairing's sync sessions, workspace then backup; pause, resume, terminate and the orphan sweep all act on these names
// together. A project pairing has the workspace session alone: its folder is the owner's project, and the backup would
// write the sandbox's state into it. Naming a session that does not exist is not harmless either, since `sync terminate
// a b` fails whole on one unresolved name.
export const syncSessionNames = (pairing: Pick<Pairing, "sandboxId" | "project">): readonly string[] =>
    isProjectPairing(pairing) ? [sessionName(pairing.sandboxId)] : [sessionName(pairing.sandboxId), backupSessionName(pairing.sandboxId)];

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

// The ports one sandbox's live forwards are bound to, read off their names. The per-tick reconcile works from the
// persisted baseline, which cannot see a session that baseline lost; this is the only thing that can.
export const parseForwardPorts = (listed: string, sandboxId: string): number[] =>
    parseForwardNames(listed, sandboxId).flatMap((name) => {
        const port = Number(FORWARD_NAME.exec(name)?.[2]);
        return Number.isInteger(port) ? [port] : [];
    });

export const forwardedPorts = (mutagen: string, sandboxId: string): number[] => parseForwardPorts(listSessionNames(mutagen, "forward"), sandboxId);

// Forward sessions no pairing in `keptSandboxIds` claims.
const orphanForwardSessions = (mutagen: string, keptSandboxIds: readonly string[]): string[] =>
    parseOrphanForwardNames(listSessionNames(mutagen, "forward"), keptSandboxIds);

// Binds the same local port and pipes it to the sandbox's recorded loopback address; `host` matters because a
// `localhost` bind inside the sandbox can land on ::1 only (Vite), where 127.0.0.1 is refused. The sandbox's side is
// reached the way its pairing reaches it (endpoint.ts): over ssh, or straight into its container through Docker.
export const mutagenForwardArgs = (args: {
    readonly name: string;
    readonly port: number;
    readonly remote: SandboxEndpoint;
    readonly host: string;
}): string[] => [
    "forward",
    "create",
    "--name",
    args.name,
    `tcp:127.0.0.1:${args.port}`,
    mutagenForwardUrl(args.remote, `tcp:${args.host.includes(":") ? `[${args.host}]` : args.host}:${args.port}`),
];

// Everything a file-sync session is made of: the two endpoints plus the findable name. One shape describes both
// what to create and what a live session is compared against. `remote` is how the sandbox's side is reached
// (endpoint.ts), part of the session's identity: a session made over ssh is not the one a docker pairing wants.
export interface SyncSessionSpec {
    readonly name: string;
    readonly localDir: string;
    readonly remote: SandboxEndpoint;
    readonly remoteDir: string;
    // Two-way for the both-edited workspace; one-way replica for the backup, whose only writer is the sandbox; one-way
    // safe for a copy-first project (syncMode).
    readonly mode: SyncSessionMode;
    readonly ignores: readonly string[];
    // Which end is alpha: Mutagen's one-way modes always propagate alpha→beta, so the backup must put the sandbox
    // first. Getting this backwards would not fail loudly, it would silently overwrite the sandbox's state with the
    // laptop's.
    readonly from: "local" | "sandbox";
    // Links are carried only where this device can create them (symlinks.ts). Where it cannot, they are left out
    // rather than failed on every cycle.
    readonly symlinks: SymlinkMode;
    // Seconds between the sandbox side's own scans (SANDBOX_POLL_SECONDS, BACKUP_POLL_SECONDS). That side is only ever
    // polled (SANDBOX_WATCH_MODE), so this is both how late a change made there arrives and how often one can cost this
    // device a cycle.
    readonly pollSeconds: number;
}

// Mutagen's names for the modes, as `sync create --sync-mode` takes them and `sync list` prints them back.
export type SyncSessionMode = "two-way-safe" | "one-way-safe" | "one-way-replica";

// COPY-FIRST: a project folder flows one way, this device (alpha) to the sandbox (beta), unless its owner opted into
// two-way. One-way-safe, measured against Mutagen 0.18.1 (README): this device's edits, creations and deletions reach
// the sandbox; nothing the sandbox does ever reaches this device; a file an agent changes or creates there is kept
// (a change as a conflict, a creation silently) rather than overwritten, and one it deletes is put back from here.
// Nothing an agent does in the sandbox can empty the owner's folder, which is what two-way let an `rm -rf` do.
export const syncMode = (pairing: Pick<Pairing, "project" | "direction">): "two-way-safe" | "one-way-safe" =>
    isProjectPairing(pairing) && projectDirection(pairing) === "to-sandbox" ? "one-way-safe" : "two-way-safe";

// The workspace session for a pairing: name and alias namespace on the sandbox id; the remote side is /work, or the
// project folder a project pairing syncs (config.ts), and each kind gets its own ignore list (ssh.ts).
export const sessionSpec = (pairing: Pairing & { readonly localDir: string }, symlinks: SymlinkMode): SyncSessionSpec => ({
    name: sessionName(pairing.sandboxId),
    localDir: pairing.localDir,
    remote: pairingEndpoint(pairing),
    remoteDir: pairingRemoteDir(pairing),
    mode: syncMode(pairing),
    ignores: ignoresFor(pairing),
    from: "local",
    symlinks,
    pollSeconds: SANDBOX_POLL_SECONDS,
});

// Mirrors the sandbox's state dir into `<localDir>/.intentic`, one-way, sandbox first — the daemon is the only
// writer. Halts rather than emptying beta when alpha's root disappears, so a mid-rebuild sandbox isn't read as a
// deleted backup. Never for a project pairing (syncSessionNames says why).
const backupSpec = (pairing: Pairing & { readonly localDir: string }, symlinks: SymlinkMode): SyncSessionSpec => ({
    name: backupSessionName(pairing.sandboxId),
    localDir: join(pairing.localDir, STATE_DIR),
    remote: pairingEndpoint(pairing),
    remoteDir: `${WORKSPACE_ROOT}/${STATE_DIR}`,
    mode: "one-way-replica",
    ignores: BACKUP_IGNORES,
    from: "sandbox",
    symlinks,
    pollSeconds: BACKUP_POLL_SECONDS,
});

// Seconds between the sandbox endpoint's own scans. Mutagen's default is 10, and that number is the whole latency of a
// change made in the sandbox reaching the device: Mutagen's Linux agent has no recursive watcher, so the poll is what
// notices. The device's own end is left at the default, since Windows and macOS watch recursively for real.
const SANDBOX_POLL_SECONDS = 2;

// THE SANDBOX SIDE IS SCANNED ON ITS TIMER AND ON NOTHING ELSE. Mutagen's default there (`portable`) also puts inotify
// watches on the 50 paths that changed last, after the first change (an idle agent holds none, which is how it once
// measured as unwatched), and rescans the whole tree on every write to one of them, at most 10 ms apart. A file written
// all the time (a growing transcript, a log, a dev database) then drives a cycle per write here whatever the interval
// says: measured, the state backup at a 60 s interval still ran 312 cycles in three minutes. Forced polling makes the
// interval the bound it reads as, one change cycle per interval at most, at the price of a hot file's change waiting
// for the next tick like any other.
const SANDBOX_WATCH_MODE = "force-poll";

// THE STATE BACKUP IS A COPY NOBODY WATCHES, so it is not polled like the workspace. While agents work, the state dir
// changes every second (each conversation's transcript grows with every message), so every scan that finds a change is
// a cycle, and each cycle re-reads every grown transcript whole on both ends (Mutagen's rsync) and writes it into
// `<folder>/.intentic`. That folder sits inside the workspace session's root, whose watcher wakes on every write there,
// ignored or not, and runs a whole workspace cycle of its own. Measured on Windows with three agents' worth of churn:
// scanned every 2 s (and on every transcript write), the Mutagen daemon spent 30% of a core, 1.8 backup and 2.6
// workspace cycles a second. A backup a minute behind loses nothing a backup is for.
const BACKUP_POLL_SECONDS = 60;

// What a session made without the flag polls at, and what protobuf JSON leaves out when it says nothing.
const MUTAGEN_DEFAULT_POLL_SECONDS = 10;

// The mode is pinned explicitly, so a version bump or global config can't silently switch it to clobbering.
// No --ignore-vcs: it misses the pointer-file .git this layout leaves; IGNORES' bare `.git` covers that instead.
export const mutagenCreateArgs = (spec: SyncSessionSpec, paused: boolean): string[] => {
    const local = spec.localDir;
    const remote = mutagenUrl(spec.remote, spec.remoteDir);
    // Which endpoint the SANDBOX is for this session, since the backup runs the other way round: polling the device
    // faster instead would cost a rescan of the laptop's disk and still leave the unwatched side on 10 seconds.
    const sandboxSide = spec.from === "local" ? "beta" : "alpha";
    return [
        "sync",
        "create",
        "--name",
        spec.name,
        "--sync-mode",
        spec.mode,
        // Pinned for the same reason, and even where it is Mutagen's default: a user's global config must not decide
        // whether this session tries to create links on a device that cannot.
        "--symlink-mode",
        spec.symlinks,
        ...(paused ? ["--paused"] : []),
        ...spec.ignores.flatMap((pattern) => ["--ignore", pattern]),
        `--watch-mode-${sandboxSide}`,
        SANDBOX_WATCH_MODE,
        `--watch-polling-interval-${sandboxSide}`,
        String(spec.pollSeconds),
        "--stage-mode-beta",
        "neighboring",
        // `from` decides which endpoint is alpha, since direction is endpoint order for a one-way session.
        ...(spec.from === "local" ? [local, remote] : [remote, local]),
    ];
};

// What the drift check and report read off a live session. Protobuf JSON omits defaults, so absent here can mean
// the zero value, not unknown; every field stays optional rather than defaulted.

// Mutagen's kind for content it scanned and will never carry: everything under an ignore pattern. It is recorded at
// all so that a directory deletion knows it would be destroying something unsynchronized — which is exactly why an
// ignored `node_modules` stops the sandbox's `rm -rf` of its parent from ever reaching this device.
const UNTRACKED = "untracked";

// One side of a snapshot entry (entry.proto). Only `kind` is read, and only to tell ignored content from a real file.
interface LiveEntry {
    readonly kind?: string;
}

// One side's edit to a path (change.proto): `old`/`new` presence is the whole message, absent old means created,
// absent new means deleted.
interface LiveChange {
    readonly path?: string;
    readonly old?: LiveEntry | null;
    readonly new?: LiveEntry | null;
}

// A conflicted path plus its colliding changes; `root` is the session-relative path from conflict.proto.
interface LiveConflict {
    readonly root?: string;
    readonly alphaChanges?: readonly LiveChange[];
    readonly betaChanges?: readonly LiveChange[];
}

// How a live session's endpoint, or the session as a whole, watches (`--watch-mode[-alpha|-beta]`) and how often it
// polls (`--watch-polling-interval[-alpha|-beta]`).
interface LiveWatch {
    readonly mode?: string;
    readonly pollingInterval?: number;
}

// One end of a live session, as `sync list --template {{json .}}` prints it.
export interface LiveEndpoint {
    readonly protocol?: string;
    readonly host?: string;
    readonly path?: string;
    readonly watch?: LiveWatch;
}

// The protocol a live end was made with. Mutagen prints it, but a reader of an end that carries none (a fixture, an
// older print) can still tell: no host is this machine, and a host with no protocol is the ssh every session before
// docker pairings was made over.
export const liveProtocol = (end: LiveEndpoint): string => end.protocol ?? (end.host === undefined ? "local" : "ssh");

export interface LiveSession {
    // The name it was created with, which several sessions may share (readSessions); read where one listing of every
    // session is looked up by name (sessionsByName).
    readonly name?: string;
    // `mode` in `sync list --template {{json .}}`, spelled as `--sync-mode` takes it; absent on a session created
    // without that flag, which Mutagen runs two-way-safe (liveMode).
    readonly mode?: string;
    // The session-wide polling interval, which an endpoint's own overrides (livePollSeconds).
    readonly watch?: LiveWatch;
    // What tells one session from another under a shared name. Names are not unique; identifiers are.
    readonly identifier?: string;
    // Both ends carry an optional host since a session may run either way (the backup's alpha is the sandbox);
    // protobuf omits a local endpoint's host, so undefined means "this machine". `protocol` is `local`, `ssh` or
    // `docker` as Mutagen prints it; read with a fallback (liveProtocol), since nothing before this build compared it.
    readonly alpha: LiveEndpoint;
    readonly beta: LiveEndpoint;
    readonly ignore: { readonly paths?: readonly string[]; readonly vcs?: boolean };
    // No mode means the session was created without `--symlink-mode`, which every Mutagen version reads as portable.
    readonly symlink?: { readonly mode?: string };
    readonly paused?: boolean;
    readonly status?: string;
    readonly conflicts?: readonly LiveConflict[];
    // Conflicts left out of the list above; the list is capped for display, never the true count.
    readonly excludedConflicts?: number;
}

// The session of this name, or undefined if none: a non-zero exit is Mutagen's "no match" or an unreachable
// daemon, and the create that follows fails loudly with the real reason.
// EVERY session under that name, not the first of them. Mutagen allows several to share one, and two synchronizers
// on one pair of roots flag each other's writes as conflicts and neither ever converges: measured on a dogfooding
// machine as 2 identical sessions, 108 conflicts, and nothing propagating in either direction while a status of
// "Watching for changes" claimed all was well. Reading `[0]` hid the second one from every check below.
const readSessions = (mutagen: string, name: string): LiveSession[] => listSessions(mutagen, [name]);

// Every session the daemon holds, in ONE `sync list`: what a report reads, rather than a process per session. Spawning
// is what that read costs on Windows, and the report runs every 15 seconds over every pairing, the paused and the long
// gone included: a dogfooding PC with 10 pairings spawned 80 Mutagen processes a minute for it. A daemon that does not
// answer reads as no sessions, as one name not found did.
export const readAllSessions = (mutagen: string): LiveSession[] => listSessions(mutagen, []);

const listSessions = (mutagen: string, names: readonly string[]): LiveSession[] => {
    const result = spawnSync(mutagen, ["sync", "list", "--template", "{{json .}}", ...names], { encoding: "utf8", windowsHide: true });
    // SAFETY: Mutagen's own JSON rendering of its session list (null when it holds none), and every field read off it
    // is optional in LiveSession, so a field this build does not know or one Mutagen left out reads as absent.
    return result.status === 0 ? ((JSON.parse(result.stdout) as LiveSession[] | null) ?? []) : [];
};

// That listing by name, the first session under each name kept: the one `readSessionState` would have read, since
// Mutagen lists by creation time and duplicates are converged away rather than described.
export const sessionsByName = (sessions: readonly LiveSession[]): ReadonlyMap<string, LiveSession> => {
    const byName = new Map<string, LiveSession>();
    for (const session of sessions) {
        if (session.name !== undefined && !byName.has(session.name)) {
            byName.set(session.name, session);
        }
    }
    return byName;
};

// Two-way-safe flags conflicts by path, not just a count; alpha is always this device (workspace session is
// created local-first). Mutagen truncates the list it reports, so the count is the true total and paths are capped
// again here.
export const CONFLICT_PATHS_MAX = 24;

// A REPOSITORY IS NOT BUILD OUTPUT. `.git` sits in the session's ignore list beside `node_modules`, so Mutagen scans
// it the same way and calls it untracked — but no build puts a repository back, and a clone whose remote has gone has
// its history nowhere else. Reported as a creation, which is what it is: the classification below then reads the
// standoff as two real copies, which is a person's call, rather than as residue a button may delete unasked.
const REPOSITORY = ".git";
const isRepository = (path: string | undefined): boolean => (path ?? "").split("/").includes(REPOSITORY);

// Created, deleted, or modified, from which side of a change is present; neither present says nothing rather
// than guessing. A creation whose content is ignored is reported as `untracked` instead, because nobody created it and
// nothing is lost by removing it — the distinction the whole classification below rests on.
const changeKind = (change: LiveChange | undefined): DeviceConflictChange | undefined => {
    if (change === undefined) {
        return undefined;
    }
    const before = change.old !== undefined && change.old !== null;
    const after = change.new !== undefined && change.new !== null;
    if (!before) {
        const ignored = change.new?.kind === UNTRACKED && !isRepository(change.path);
        return after ? (ignored ? "untracked" : "created") : undefined;
    }
    return after ? "modified" : "deleted";
};

// What one side did, for the row. A conflict rooted at a directory carries its changes UNDERNEATH that root rather than
// at it, so there is usually nothing to match and the side has to be summarised: unanimous kinds are that kind, and a
// mixed side reports anything that is not `untracked`. The asymmetry is deliberate — `untracked` licenses deleting the
// directory unasked, so it is claimed only when every change on that side is ignored content and never when one real
// file sits among them.
const sideKind = (changes: readonly LiveChange[] | undefined, root: string): DeviceConflictChange | undefined => {
    const atRoot = changes?.find((change) => (change.path ?? "") === root);
    if (atRoot !== undefined) {
        return changeKind(atRoot);
    }
    const kinds = (changes ?? []).map(changeKind);
    if (kinds.length === 0) {
        return undefined;
    }
    return kinds.every((kind) => kind === kinds[0]) ? kinds[0] : (kinds.find((kind) => kind !== UNTRACKED) ?? kinds[0]);
};

// The one conflict shape that is not a disagreement: one side holds nothing but ignored content, the other deleted the
// directory holding it. Everything else is two real copies and a person's call.
const natureOf = (local: DeviceConflictChange | undefined, sandbox: DeviceConflictChange | undefined): DeviceConflictNature =>
    (local === "untracked" && sandbox === "deleted") || (sandbox === "untracked" && local === "deleted") ? "derived-leftover" : "both-edited";

const conflictedPath = (conflict: LiveConflict): DeviceConflict => {
    // An empty root is the synced folder itself; a change's path is the fallback when the conflict carried none.
    const path = conflict.root ?? conflict.alphaChanges?.[0]?.path ?? conflict.betaChanges?.[0]?.path ?? "";
    const local = sideKind(conflict.alphaChanges, path);
    const sandbox = sideKind(conflict.betaChanges, path);
    return {
        path,
        ...(local === undefined ? {} : { local }),
        ...(sandbox === undefined ? {} : { sandbox }),
        nature: natureOf(local, sandbox),
    };
};

// What the heal needs, in one `sync list`: every conflict the daemon reports, classified and UNCAPPED (the report caps
// what it shows; a heal that saw only the first 24 would clear those, leave the session wedged on the rest, and say it
// had succeeded), beside the ignore list the LIVE session carries. That list, not this build's IGNORES: Mutagen freezes
// it at creation, so a session made by an older agent decides what "ignored" means by the rules it was born with.
export interface SessionConflicts {
    readonly ignores: readonly string[];
    readonly conflicts: readonly DeviceConflict[];
}

export const readSessionConflicts = (mutagen: string, name: string): SessionConflicts | undefined => {
    const session = readSessions(mutagen, name)[0];
    return session === undefined ? undefined : { ignores: session.ignore.paths ?? [], conflicts: (session.conflicts ?? []).map(conflictedPath) };
};

// Asks for a cycle now rather than at the watcher's leisure. Always `--skip-wait`: this is called from the resident
// agent, a full cycle over a large workspace outlives any tick, and Mutagen's own filesystem watch picks the change up
// regardless — the flush only stops it waiting for a coalescing window it has no reason to keep.
export const flushSession = async (mutagen: string, name: string): Promise<void> => {
    await runProcess(mutagen, ["sync", "flush", "--skip-wait", name]);
};

export const conflictsFrom = (
    session: Pick<LiveSession, "conflicts" | "excludedConflicts">,
): { count: number; paths: DeviceConflict[] } | undefined => {
    const listed = session.conflicts ?? [];
    const excluded = Number(session.excludedConflicts ?? 0);
    const count = listed.length + (Number.isFinite(excluded) ? excluded : 0);
    // Absent means "none reported", not zero; never interpolated into a sentence about what's wrong.
    return count === 0 ? undefined : { count, paths: listed.slice(0, CONFLICT_PATHS_MAX).map(conflictedPath) };
};

// Keeps Mutagen's status word instead of a traffic light; halted states name their own cause. `exists` is
// separate from `status` since protobuf omits the zero value ("disconnected"), which would else look like no session.
export interface SessionState {
    readonly exists: boolean;
    readonly status?: string | undefined;
    readonly paused?: boolean | undefined;
    readonly conflicts?: number | undefined;
    readonly conflictedPaths?: DeviceConflict[] | undefined;
}

export const readSessionState = (mutagen: string, name: string): SessionState =>
    // The first of them is enough for a report: what a reader needs is that this pairing is syncing and how it is
    // doing, and duplicates are converged away by `convergeSession` rather than described here.
    sessionStateOf(readSessions(mutagen, name)[0]);

// The same, of a session already read (or of none).
export const sessionStateOf = (session: LiveSession | undefined): SessionState => {
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

// Pauses a pairing's file sync, without touching a deliberate manual pause: answers whether it paused anything, and a
// pairing whose sessions are all paused already (or that has none) is left alone, so its pause is not this caller's to
// undo. Both sessions pause/resume as a pair. Used for a sandbox unreachable for an hour, and for one being swapped on
// this machine (swap-pause.ts).
export const pauseRunningSync = (mutagen: string, pairing: Pairing): boolean => {
    if (pairing.mode !== "sync") {
        return false;
    }
    const names = existingSyncSessions(mutagen, syncSessionNames(pairing));
    // `every` over an empty list is true, so "no sessions" and "all paused" share the branch on purpose.
    if (names.every((name) => readSessionState(mutagen, name).paused === true)) {
        return false;
    }
    const result = spawnSync(mutagen, ["sync", "pause", ...names], { stdio: "ignore", windowsHide: true });
    return result.status === 0;
};

export const pauseUnreachableSync = pauseRunningSync;

// Lifts the pause a swap of the sandbox put on its file sync. Every session the pairing has: that pause paused them all.
export const resumeSwapPausedSync = (mutagen: string, pairing: Pairing): boolean => {
    const names = existingSyncSessions(mutagen, syncSessionNames(pairing));
    if (names.length === 0) {
        return false;
    }
    return spawnSync(mutagen, ["sync", "resume", ...names], { stdio: "ignore", windowsHide: true }).status === 0;
};

export const resumeAutoPausedSync = (mutagen: string, pairing: Pairing): boolean => {
    if (pairing.mode !== "sync" || pairing.fileSyncAutoPaused !== true) {
        return false;
    }
    const names = existingSyncSessions(mutagen, syncSessionNames(pairing));
    if (names.length === 0) {
        return false;
    }
    const result = spawnSync(mutagen, ["sync", "resume", ...names], { stdio: "ignore", windowsHide: true });
    return result.status === 0;
};

// Whether a live session joins the same two folders the spec does, in the same direction. Which endpoint should hold
// what follows the spec's direction; a backup with reversed ends must never read as "close enough" — it would upload
// instead of download. A remote dir that moved (a pairing set up again for another folder in the sandbox) is a
// different pair of ends as much as a local one is, and so is the same folder reached another way: a session made over
// ssh is replaced once its pairing reaches the sandbox through Docker, and the other way round.
export const sameEnds = (session: Pick<LiveSession, "alpha" | "beta">, spec: SyncSessionSpec): boolean => {
    const local: Required<Pick<LiveEndpoint, "protocol" | "path">> & { readonly host: undefined } = { protocol: "local", host: undefined, path: spec.localDir };
    const remote = { ...liveIdentity(spec.remote), path: spec.remoteDir };
    const [alpha, beta] = spec.from === "local" ? [local, remote] : [remote, local];
    const matches = (live: LiveEndpoint, wanted: { readonly protocol: string; readonly host: string | undefined; readonly path: string }): boolean =>
        live.path === wanted.path && live.host === wanted.host && liveProtocol(live) === wanted.protocol;
    return matches(session.alpha, alpha) && matches(session.beta, beta);
};

// The mode a live session runs in. Protobuf JSON omits the default, and a session created without `--sync-mode` (none of
// this agent's) runs Mutagen's default, two-way-safe.
export const liveMode = (session: Pick<LiveSession, "mode">): string => session.mode ?? "two-way-safe";

// How a live session watches its sandbox side, and how often it polls it: that endpoint's own setting, else the
// session's, else Mutagen's default, each absent from the JSON when it was never set. Which endpoint is the sandbox
// follows the spec's direction.
const sandboxWatch = (session: Pick<LiveSession, "alpha" | "beta">, from: SyncSessionSpec["from"]): LiveWatch | undefined =>
    (from === "local" ? session.beta : session.alpha).watch;

export const liveWatchMode = (session: Pick<LiveSession, "alpha" | "beta" | "watch">, from: SyncSessionSpec["from"]): string =>
    sandboxWatch(session, from)?.mode ?? session.watch?.mode ?? "portable";

export const livePollSeconds = (session: Pick<LiveSession, "alpha" | "beta" | "watch">, from: SyncSessionSpec["from"]): number =>
    sandboxWatch(session, from)?.pollingInterval ?? session.watch?.pollingInterval ?? MUTAGEN_DEFAULT_POLL_SECONDS;

// Whether the running session is what this build would create. Mutagen freezes config at `sync create` with no
// edit verb, so a stale ignore list means a session that will never behave like this version says. The mode is part of
// it: a project whose direction changed, or one an older agent created two-way, is recreated in the mode it now has.
// So is how the sandbox side is scanned: a session an older agent made rescans on every write to a busy file, its
// backup every two seconds besides, for as long as it runs.
export const sessionMatchesSpec = (session: LiveSession, spec: SyncSessionSpec): boolean => {
    return (
        sameEnds(session, spec) &&
        liveMode(session) === spec.mode &&
        liveWatchMode(session, spec.from) === SANDBOX_WATCH_MODE &&
        livePollSeconds(session, spec.from) === spec.pollSeconds &&
        session.ignore.vcs !== true &&
        (session.ignore.paths ?? []).join("\n") === spec.ignores.join("\n") &&
        // A session made before the mode was pinned carries none, and that is portable. It must still match a portable
        // spec: otherwise every paired device would recreate its sessions on the first start of this build.
        (session.symlink?.mode ?? "portable") === spec.symlinks
    );
};

// Converges the session to this build's spec: creates if missing, recreates if drifted, since recreating is the
// only way to change ignores. Cheap when content already matches (a rescan, not a re-download); a paused session stays
// paused. Answers whether both sessions now ARE the spec: false means something was put off (a create that failed is
// thrown instead), and the watcher tries again on its cadence rather than at its next start.
export const ensureSyncSession = async (mutagen: string, pairing: Pairing, log: Log): Promise<boolean> => {
    if (pairing.mode !== "sync" || pairing.localDir === undefined) {
        return true; // a mirror-only enrollment has no file sync at all: just port forwards
    }
    const held = { ...pairing, localDir: pairing.localDir };
    const symlinks = await deviceSymlinks();
    if (symlinks.refusal !== undefined) {
        log(
            `${pairing.sandboxId}: this device cannot create symbolic links (${symlinks.refusal}), so its file sync leaves them out instead of failing on each one every cycle. On Windows, turning on Developer Mode lets the next start of this agent carry them.`,
        );
    }
    // Both sessions, converged in order, sequential since they share one ssh transport and daemon; workspace first
    // since that's what the user is waiting on. An unreachable sandbox leaves both alone, never half-converged.
    let converged = true;
    const answers = transportAnswers(pairing);
    for (const spec of sessionSpecs(held, symlinks.mode)) {
        converged = (await convergeSession(mutagen, spec, log, answers)) && converged;
    }
    retireStrayBackup(mutagen, pairing, log);
    return converged;
};

// What one pairing's sessions should be, in the order they are converged.
export const sessionSpecs = (pairing: Pairing & { readonly localDir: string }, symlinks: SymlinkMode): readonly SyncSessionSpec[] =>
    isProjectPairing(pairing) ? [sessionSpec(pairing, symlinks)] : [sessionSpec(pairing, symlinks), backupSpec(pairing, symlinks)];

// A state backup a project pairing should never have had, found and terminated: an older agent's, or one left from when
// this sandbox was paired as a workspace. Surplus rather than a choice, since it writes the sandbox's state dir into the
// owner's own project folder for as long as it runs.
export const strayBackupSessions = (pairing: Pick<Pairing, "sandboxId" | "project">, live: readonly string[]): string[] =>
    isProjectPairing(pairing) ? live.filter((name) => name === backupSessionName(pairing.sandboxId)) : [];

const retireStrayBackup = (mutagen: string, pairing: Pairing, log: Log): void => {
    const stray = strayBackupSessions(pairing, existingSyncSessions(mutagen, [backupSessionName(pairing.sandboxId)]));
    if (stray.length === 0) {
        return;
    }
    spawnSync(mutagen, ["sync", "terminate", ...stray], { stdio: "ignore", windowsHide: true });
    log(`${pairing.sandboxId}: its folder is a project of yours, which carries no copy of the sandbox's state; terminated the state backup that was writing one into it.`);
};

// Every session under one name except the oldest, by identifier. Mutagen lists sessions by creation time. Terminating
// a duplicate loses nothing, because the one kept holds its own record of what the two ends last agreed on. Replacing
// them all at once instead waits for a settled pair of roots, and duplicates are what keep one from settling: each
// flags the other's writes as conflicts.
export const surplusSessions = (sessions: readonly LiveSession[]): string[] =>
    sessions.slice(1).flatMap((session) => (session.identifier === undefined ? [] : [session.identifier]));

// One synchronizer per name before anything else is decided. The list is read again rather than assumed: if a
// terminate did not take, the duplicates are still there, and convergePlan replaces them all from a settled state as
// it did before.
const retireSurplus = (mutagen: string, name: string, log: Log): LiveSession[] => {
    const sessions = readSessions(mutagen, name);
    const surplus = surplusSessions(sessions);
    if (surplus.length === 0) {
        return sessions;
    }
    spawnSync(mutagen, ["sync", "terminate", ...surplus], { stdio: "ignore", windowsHide: true });
    log(`${name}: ${sessions.length} sync sessions shared this name and flagged each other's writes as conflicts; kept the oldest and terminated the rest.`);
    return readSessions(mutagen, name);
};

// What to do with what `sync list <name>` answered. Kept pure and beside `sessionMatchesSpec` so the one case that
// cost a dogfooding machine its file sync — SEVERAL sessions under one name, each flagging the other's writes as
// conflicts — is a rule with a test rather than a branch inside a process spawner.
export const convergePlan = (sessions: readonly LiveSession[], spec: SyncSessionSpec): "keep" | "create" | "replace" => {
    if (sessions.length === 0) {
        return "create";
    }
    const only = sessions.length === 1 ? sessions[0] : undefined;
    return only !== undefined && sessionMatchesSpec(only, spec) ? "keep" : "replace";
};

// Whether a replacement waits for a settled pair of roots and sweeps residue first (readyForReplacement): only a
// two-way session replaced by another. Everything else is replaced as soon as the sandbox answers:
// - The state backup runs one-way from the sandbox into its own state dir: nothing of this device's making is there.
// - Into copy-first (one-way-safe): settling flushes the old two-way session, which carries the sandbox's latest
//   changes, an agent's `rm -rf` among them, into the owner's folder one last time; that is what the new mode exists to
//   stop. Its conflicts cost nothing, since the new session never writes to this device, and the sweep removes local
//   content because the sandbox lacks it. Whatever the sandbox holds that the folder does not stays there, for
//   `sync changes` and `sync bring-back`.
// - Out of copy-first (the owner chose `both`): what a one-way-safe session calls a conflict is an agent's edit it
//   kept, two different copies whichever session holds them, so waiting on them would hold the switch until they were
//   brought back, for nothing. A fresh two-way-safe session has no history, so it deletes nothing: it copies what one
//   side alone holds to the other, and reports what differs as a conflict (README). And the sweep reads "absent in the
//   sandbox" as "deleted there", which only two-way syncing makes true.
export const settlesFirst = (spec: Pick<SyncSessionSpec, "mode">, live: readonly Pick<LiveSession, "mode">[]): boolean =>
    spec.mode === "two-way-safe" && live.every((session) => liveMode(session) === "two-way-safe");

// WHAT A REPLACEMENT COSTS, which is why one is never done blind. Mutagen's record of what the two ends last agreed on
// lives inside the session; terminating it throws that away, and the replacement reconciles two trees with no history
// between them. Every path that differs at that moment then reads as created on BOTH sides at once — the one shape
// two-way-safe can never settle — so a session is replaced only from a settled state, and residue is swept first so it
// is not propagated back to the sandbox as empty directories by a sync with nothing to compare against.
// That is a rule about a TWO-WAY session replaced by another, the only replacement that settles first (settlesFirst).
const readyForReplacement = async (mutagen: string, spec: SyncSessionSpec, live: readonly LiveSession[], log: Log): Promise<boolean> => {
    if (!settlesFirst(spec, live)) {
        return true;
    }
    await flushSession(mutagen, spec.name);
    const held = readSessionConflicts(mutagen, spec.name);
    const cleared =
        held === undefined || held.conflicts.length === 0
            ? { standing: 0 }
            : await clearConflictResidue({ root: spec.localDir, conflicts: held.conflicts, ignores: held.ignores, log });
    if (cleared.standing > 0) {
        log(
            `${spec.name}: ${plural(cleared.standing, "conflict")} still standing, so this session keeps the rules it was created with rather than being recreated on top of them — a fresh session has no record of what the two ends last agreed on, which would turn every one of those into a collision neither side can win. Settle them and this converges by itself.`,
        );
        return false;
    }
    // The sweep below reads "absent in the sandbox" as "deleted there", true only of the folder this device has been
    // syncing with. A session moving to another folder would read everything the new one lacks as deleted, and remove
    // this device's build output for it; an empty directory pushed back there costs nothing by comparison.
    if (!live.every((session) => sameEnds(session, spec))) {
        return true;
    }
    // Residue nobody has flagged yet matters here for a reason of its own: with no history to compare against, a fresh
    // session reads a directory this device holds and the sandbox does not as something to CREATE there, and pushes
    // the husk back as an empty directory in /work.
    await sweepDerivedResidue({
        exec: { run: async (command, args) => await remoteAnswer(command, args) },
        root: spec.localDir,
        remote: spec.remote,
        remoteDir: spec.remoteDir,
        ignores: spec.ignores,
        log,
    });
    return true;
};

// stdout when the command SUCCEEDED, undefined when it did not — including an empty answer from a successful run,
// which means "every path is still there" and must never be read as the failure that sweeps nothing.
const remoteAnswer = async (command: string, args: readonly string[]): Promise<string | undefined> => {
    const result = await runProcess(command, args, { timeoutMs: SWEEP_TIMEOUT_MS });
    return result.status === 0 ? result.stdout : undefined;
};

// Whether the sandbox's side answers the way this pairing reaches it, asked before a session is torn down for a
// replacement and, for a docker pairing, before any session is made: a container name outlives what runs under it, and
// one that is no longer this sandbox (a removed sandbox, a new one on the same engine) must never receive the folder.
export const transportAnswers = (pairing: Pick<Pairing, "sandboxId" | "sandboxUrl" | "transport" | "container">): (() => Promise<boolean>) => {
    const endpoint = pairingEndpoint(pairing);
    return endpoint.kind === "docker"
        ? async () => await dockerEndpointAnswers(endpoint.container, pairing.sandboxUrl)
        : async () => await sshTransportAnswers(mutagenSshPath(process.platform, process.env["MUTAGEN_SSH_PATH"]), endpoint.alias);
};

const convergeSession = async (mutagen: string, spec: SyncSessionSpec, log: Log, answers: () => Promise<boolean>): Promise<boolean> => {
    const sessions = retireSurplus(mutagen, spec.name, log);
    const plan = convergePlan(sessions, spec);
    if (plan === "keep") {
        return true;
    }
    const live = sessions.length === 1 ? sessions[0] : undefined;
    if (sessions.length > 1) {
        log(`${spec.name}: ${sessions.length} sync sessions share this name, which conflict with each other; replacing them with one.`);
    }
    if (plan === "create" && spec.remote.kind === "docker" && !(await answers())) {
        log(
            `${spec.name}: ${spec.remote.container} is not running on this machine's Docker engine as this sandbox, so no file sync is made into it. Retrying later.`,
        );
        return false;
    }
    if (plan === "replace") {
        // Never tears down a session it can't replace: `sync create` needs the sandbox to answer, so the transport is
        // probed first, and an unreachable sandbox keeps its drifted session (retried on the watcher's cadence) rather
        // than losing sync entirely.
        if (!(await answers())) {
            log(
                `${spec.name}: the sandbox is not answering, so its existing file sync is left running as it is rather than terminated for a replacement that cannot be created. Retrying later.`,
            );
            return false;
        }
        if (!(await readyForReplacement(mutagen, spec, sessions, log))) {
            return false;
        }
        log(
            `${spec.name}: the running sync session does not match this build's rules (its ignores, its folder, which way it syncs, or what it does with symbolic links): recreating it so they apply, as ${spec.mode}. This starts the comparison from scratch.`,
        );
        spawnSync(mutagen, ["sync", "terminate", spec.name], { stdio: "ignore", windowsHide: true });
    }
    await runMutagenAsync(mutagen, mutagenCreateArgs(spec, live?.paused === true), log);
    return true;
};

// One ssh round trip asking whether a handful of directories still exist; generous enough for a loaded laptop, bounded
// so a hung transport cannot wedge the pass that was about to replace a session.
const SWEEP_TIMEOUT_MS = 60_000;

// THE HEAL: read this pairing's conflicts, clear the ones that are only this device's build output standing in the way
// of a deletion, and ask for a cycle so the deletions it was blocking can land. Everything else is left exactly where it
// is. `autoHealOff` is the owner's switch over the watcher doing this unprompted, not a fallback for uncertainty —
// uncertainty is handled by refusing to remove, inside `clearConflictResidue`. `asked` is somebody pressing the button
// or typing the command, which the switch does not govern: turning off a standing habit is not withholding consent for
// the thing itself.
export const healDerivedConflicts = async (mutagen: string, pairing: Pairing, log: Log, asked = false): Promise<ResidueOutcome> => {
    const idle = { removed: [], standing: 0 } as const;
    // A copy-first project never has anything removed here on the sandbox's say-so; its deletions are not carried back
    // at all, so none is ever held up by build output on this device.
    if (pairing.mode !== "sync" || pairing.localDir === undefined || syncMode(pairing) !== "two-way-safe") {
        return idle;
    }
    if (!asked && (pairing.autoHealOff === true || pairing.fileSyncAutoPaused === true)) {
        return idle;
    }
    const held = readSessionConflicts(mutagen, sessionName(pairing.sandboxId));
    if (held === undefined || held.conflicts.length === 0) {
        return idle;
    }
    const outcome = await clearConflictResidue({ root: pairing.localDir, conflicts: held.conflicts, ignores: held.ignores, log });
    if (outcome.removed.length > 0) {
        await flushSession(mutagen, sessionName(pairing.sandboxId));
    }
    return outcome;
};

// Sweeps file-sync and forward sessions no pairing claims any more, so an unpaired sandbox stops being dialled
// and releases its ports. Must never fire merely because another sandbox was added.
export const retireOrphanSessions = (mutagen: string, pairings: readonly Pairing[], log: Log): void => {
    const ids = pairings.map((pairing) => pairing.sandboxId);
    const sessions = parseOrphanSyncNames(
        listSessionNames(mutagen, "sync"),
        pairings.flatMap((pairing) => syncSessionNames(pairing)),
    );
    if (sessions.length > 0) {
        spawnSync(mutagen, ["sync", "terminate", ...sessions], { stdio: "ignore", windowsHide: true });
        log(`retired ${plural(sessions.length, "file-sync session")} belonging to sandboxes this machine no longer pairs.`);
    }
    const forwards = orphanForwardSessions(mutagen, ids);
    if (forwards.length > 0) {
        spawnSync(mutagen, ["forward", "terminate", ...forwards], { stdio: "ignore", windowsHide: true });
        log(`released ${plural(forwards.length, "port forward")} left holding localhost for sandboxes this machine no longer pairs.`);
    }
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

// Extract a gzipped tarball into this agent's own bin using the system `tar` (bsdtar on macOS/Windows 10+).
const extractTarball = (tarball: string): void => {
    const extract = spawnSync("tar", ["-xzf", tarball, "-C", binDir], { stdio: "inherit", windowsHide: true });
    if (extract.status !== 0) {
        throw new Error(`failed to extract ${tarball}: tar's own reason is above (no \`tar\` on PATH, or a file it must replace is in use)`);
    }
};

// Where PATH's copy of a command is at this moment. A bare name is resolved again every time it is run, against a
// PATH this agent does not control, which is how an autostart entry keeps starting a binary from a retired install.
const resolveOnPath = (command: string): string | undefined => {
    const whereExe = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "where.exe");
    const found =
        process.platform === "win32"
            ? spawnSync(whereExe, [command], { encoding: "utf8", windowsHide: true })
            : spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
    // `where` lists every match, best first; `command -v` prints the single one it would run.
    const first = found.status === 0 ? found.stdout.split("\n")[0]?.trim() : undefined;
    return first === undefined || first === "" || !existsSync(first) ? undefined : first;
};

// The copy this agent downloads and runs when the machine has no Mutagen of its own.
export const ownMutagenPath = (): string => join(binDir, `mutagen${exe}`);

// Whether a resolved Mutagen is that copy, rather than the user's own install found on PATH: only this agent's copy's
// daemon is this agent's to stop and unregister, since the user's may hold sessions of their own. Paths compare as the
// platform does (case-insensitively on Windows).
export const isOwnMutagen = (mutagen: string, own: string = ownMutagenPath(), platform: NodeJS.Platform = process.platform): boolean => {
    const fold = (path: string): string => (platform === "win32" ? path.replaceAll("/", "\\").toLowerCase() : path);
    return fold(mutagen) === fold(own);
};

// Resolves mutagen to an absolute path and never a bare name (see resolveOnPath): the user's own install if
// present, else the pinned copy, downloaded and extracted only when our bin isn't already at that version.
export const ensureMutagen = async (): Promise<string> => {
    const own = resolveOnPath("mutagen");
    if (own !== undefined && installedVersion(own, ["version"]) !== undefined) {
        return own;
    }
    const dest = ownMutagenPath();
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
    // Extraction writes in place, so the running copy is set aside first and dropped once the new one lands.
    const displaced = `${dest}.old`;
    await renameIfPresent(dest, displaced);
    extractTarball(tarball);
    await chmod(dest, 0o755);
    await rm(displaced, { force: true }).catch(() => undefined);
    await rm(tarball, { force: true }).catch(() => undefined);
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
