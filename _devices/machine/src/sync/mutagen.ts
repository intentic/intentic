import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { binDir, mutagenDaemonLogPath, type Pairing } from "./config.js";
import { runProcess } from "./exec.js";
import { clearConflictResidue, type ResidueOutcome, sweepDerivedResidue } from "./residue.js";
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

// The ports one sandbox's live forwards are bound to, read off their names. The per-tick reconcile works from the
// persisted baseline, which cannot see a session that baseline lost; this is the only thing that can.
export const parseForwardPorts = (listed: string, sandboxId: string): number[] =>
    parseForwardNames(listed, sandboxId).flatMap((name) => {
        const port = Number(FORWARD_NAME.exec(name)?.[2]);
        return Number.isInteger(port) ? [port] : [];
    });

export const forwardedPorts = (mutagen: string, sandboxId: string): number[] =>
    parseForwardPorts(listSessionNames(mutagen, "forward"), sandboxId);

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
// EVERY session under that name, not the first of them. Mutagen allows several to share one, and two synchronizers
// on one pair of roots flag each other's writes as conflicts and neither ever converges: measured on a dogfooding
// machine as 2 identical sessions, 108 conflicts, and nothing propagating in either direction while a status of
// "Watching for changes" claimed all was well. Reading `[0]` hid the second one from every check below.
const readSessions = (mutagen: string, name: string): LiveSession[] => {
    const result = spawnSync(mutagen, ["sync", "list", "--template", "{{json .}}", name], { encoding: "utf8", windowsHide: true });
    return result.status === 0 ? ((JSON.parse(result.stdout) as LiveSession[]) ?? []) : [];
};

// Two-way-safe flags conflicts by path, not just a count; alpha is always this device (workspace session is
// created local-first). Mutagen truncates the list it reports, so the count is the true total and paths are capped
// again here.
export const CONFLICT_PATHS_MAX = 24;

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
        return after ? (change.new?.kind === UNTRACKED ? "untracked" : "created") : undefined;
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
// loop, a full cycle over a large workspace outlives any tick, and Mutagen's own filesystem watch picks the change up
// regardless — the flush only stops it waiting for a coalescing window it has no reason to keep.
export const flushSession = async (mutagen: string, name: string): Promise<void> => {
    await runProcess(mutagen, ["sync", "flush", "--skip-wait", name]);
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
    // The first of them is enough for a report: what a reader needs is that this pairing is syncing and how it is
    // doing, and duplicates are converged away by `convergeSession` rather than described here.
    const session = readSessions(mutagen, name)[0];
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

// WHAT A REPLACEMENT COSTS, which is why one is never done blind. Mutagen's record of what the two ends last agreed on
// lives inside the session; terminating it throws that away, and the replacement reconciles two trees with no history
// between them. Every path that differs at that moment then reads as created on BOTH sides at once — the one shape
// two-way-safe can never settle — so a session is replaced only from a settled state, and residue is swept first so it
// is not propagated back to the sandbox as empty directories by a sync with nothing to compare against.
const readyForReplacement = async (mutagen: string, spec: SyncSessionSpec, log: Log): Promise<boolean> => {
    // The backup session is one-way from the sandbox and its root is the sandbox's own state dir: nothing of this
    // device's making is in there to settle or to sweep, so it is replaced as it always was.
    if (spec.mode !== "two-way-safe") {
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
    // Residue nobody has flagged yet matters here for a reason of its own: with no history to compare against, a fresh
    // session reads a directory this device holds and the sandbox does not as something to CREATE there, and pushes
    // the husk back as an empty directory in /work.
    await sweepDerivedResidue({
        exec: { run: async (command, args) => await sshAnswer(command, args) },
        root: spec.localDir,
        alias: spec.alias,
        remoteDir: spec.remoteDir,
        ignores: spec.ignores,
        log,
    });
    return true;
};

// stdout when the command SUCCEEDED, undefined when it did not — including an empty answer from a successful run,
// which means "every path is still there" and must never be read as the failure that sweeps nothing.
const sshAnswer = async (command: string, args: readonly string[]): Promise<string | undefined> => {
    const result = await runProcess(command, args, { timeoutMs: SWEEP_TIMEOUT_MS });
    return result.status === 0 ? result.stdout : undefined;
};

const convergeSession = async (mutagen: string, spec: SyncSessionSpec, log: Log): Promise<void> => {
    const sessions = readSessions(mutagen, spec.name);
    const plan = convergePlan(sessions, spec);
    if (plan === "keep") {
        return;
    }
    const live = sessions.length === 1 ? sessions[0] : undefined;
    if (sessions.length > 1) {
        log(`${spec.name}: ${sessions.length} sync sessions share this name, which conflict with each other; replacing them with one.`);
    }
    if (plan === "replace") {
        // Never tears down a session it can't replace: `sync create` needs the sandbox to answer, so the transport is
        // probed first, and an unreachable sandbox keeps its drifted session (retried next pass) rather than losing
        // sync entirely.
        if (!(await sshTransportAnswers(mutagenSshPath(process.platform, process.env["MUTAGEN_SSH_PATH"]), spec.alias))) {
            log(
                `${spec.name}: the sandbox is not answering, so its existing file sync is left running as it is rather than terminated for a replacement that cannot be created. Retrying later.`,
            );
            return;
        }
        if (!(await readyForReplacement(mutagen, spec, log))) {
            return;
        }
        log(
            "the running sync session does not match this build's spec: recreating it so the current rules apply (no .git file-syncs; commits arrive via the git bridge instead). This starts the comparison from scratch, which is why it only happens from a settled state.",
        );
        spawnSync(mutagen, ["sync", "terminate", spec.name], { stdio: "ignore", windowsHide: true });
    }
    await runMutagenAsync(mutagen, mutagenCreateArgs(spec, live?.paused === true), log);
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
    if (pairing.mode !== "sync" || pairing.localDir === undefined) {
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
        pairings.flatMap((pairing) => syncSessionNames(pairing.sandboxId)),
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

// Resolves mutagen to an absolute path and never a bare name (see resolveOnPath): the user's own install if
// present, else the pinned copy, downloaded and extracted only when our bin isn't already at that version.
export const ensureMutagen = async (): Promise<string> => {
    const own = resolveOnPath("mutagen");
    if (own !== undefined && installedVersion(own, ["version"]) !== undefined) {
        return own;
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
