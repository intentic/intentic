import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { readTextIfExists } from "@intentic/base/fs";
import { parseJsonOr } from "@intentic/base/json";
import { clearWindowsRunValue, homeDir, type Log } from "@intentic/local-agent";
import { readRegistryValue } from "../windows-registry.js";
import { sessionOwner } from "./environment.js";
import { runProcessSync } from "./exec.js";
import {
    existingSyncSessions,
    MUTAGEN_CALL_TIMEOUT_MS,
    MUTAGEN_RUN_VALUE,
    ownershipOf,
    ownMutagenPath,
    resolveOnPath,
    saysDaemonDown,
    saysVersionMismatch,
    SESSION_PREFIX,
    startMutagenDaemon,
} from "./mutagen.js";
import { movedAlready, mutagenDataDir, recordMove } from "./mutagen-env.js";

/* OFF MUTAGEN'S SHARED DATA DIRECTORY, once (2026-10-18). Builds before mutagen-env.ts kept this agent's sessions and
   forwards in the user's own `~/.mutagen` (or wherever their MUTAGEN_DATA_DIRECTORY pointed), under a daemon they share
   with any Mutagen of their own. A sync session is CARRIED, not made again: paused there, its state files (Mutagen's
   `sessions/<id>`, and `archives/<id>`, the last state both sides agreed on) copied into this agent's own directory,
   ended there, and loaded by this agent's daemon, which then resumes what was running. Made again from nothing instead,
   a two-way-safe session has no record of what both sides last agreed on: a file deleted on one side while the session
   could not sync came back from the other, and a file changed on one side only read as a conflict. That was every
   session of a sandbox not answering at the move, and nothing could be flushed first: the move runs as the agent starts,
   before the transport its sessions ride (tunnel.ts) is up. What cannot be carried (a session with no state file, one
   this agent's daemon already holds under that name) is ended and made again by the watcher, as any missing session is
   (mutagen.ts convergeSession), its pause carried over (below). Forwards hold no state and are ended and made again.
   What is this agent's is said strictly as every sweep here says it: a name under its prefix that no other owner's
   label claims (mutagen.ts ownershipOf). The old daemon is stopped only when nothing else is left in it, or when this
   move is what started it; a daemon still holding the user's own sessions keeps running. One of another Mutagen version
   refuses this agent's client outright, so it is stopped (`daemon stop` skips the version check) and started with this
   agent's copy for the move, as the watcher always answered a mismatched daemon, and afterwards started again with the
   owner's own Mutagen where one is on PATH. Mutagen's own sign-in registration goes only where it starts this agent's
   copy, which only this agent's older builds wrote. */

// What `sync list` and `forward list` print of one session under `{{json .}}`, as far as the move reads it.
export interface StoredSession {
    readonly name?: string;
    readonly identifier?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly paused?: boolean;
}

// One of this agent's sync sessions in the old directory: by name (how the watcher knows it), by identifier (how Mutagen
// files its state, and the target that names this one session alone), and whether it was paused.
export interface MovingSession {
    readonly name: string;
    readonly target: string;
    readonly identifier: string | undefined;
    readonly paused: boolean;
}

export interface MovePlan {
    readonly sync: readonly MovingSession[];
    readonly terminateForwards: readonly string[];
    // Whether anything not this agent's is in the old directory.
    readonly othersRemain: boolean;
}

const ours = (session: StoredSession, owner: string): session is StoredSession & { readonly name: string } =>
    session.name?.startsWith(SESSION_PREFIX) === true && ownershipOf(session.labels, owner) !== "theirs";

// What moving this agent's part of the old directory takes. Pure.
export const movePlan = (sync: readonly StoredSession[], forwards: readonly StoredSession[], owner: string): MovePlan => {
    const mine = sync.filter((session) => ours(session, owner));
    const mineForwards = forwards.filter((session) => ours(session, owner));
    return {
        sync: mine.map((session) => ({
            name: session.name,
            target: session.identifier ?? session.name,
            identifier: session.identifier,
            paused: session.paused === true,
        })),
        terminateForwards: mineForwards.map((session) => session.identifier ?? session.name),
        othersRemain: mine.length < sync.length || mineForwards.length < forwards.length,
    };
};

// Whether the old daemon goes once this agent's sessions have: when nothing else is in it, or when the move started it
// and so leaves it as it found it. Pure.
export const stopsOldDaemon = (plan: Pick<MovePlan, "othersRemain">, startedByMove: boolean): boolean => !plan.othersRemain || startedByMove;

// One Mutagen call: whether it succeeded, what it printed, and what it said on failure.
export interface MutagenCall {
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
}

// What the move acts through, injectable so its order and its choices are checkable without a Mutagen daemon.
export interface MoveSeams {
    // A Mutagen call over the shared directory; `autostart` lets it start the daemon there.
    readonly shared: (args: readonly string[], autostart?: boolean) => MutagenCall;
    // A Mutagen call over this agent's own directory.
    readonly own: (args: readonly string[]) => boolean;
    // Starts this agent's own daemon, or finds it running.
    readonly startOwn: () => boolean;
    // Which of these names this agent's own daemon holds; undefined when it did not answer.
    readonly ownSessions: (names: readonly string[]) => readonly string[] | undefined;
    // Copies one session's state into this agent's own directory: true once it is there whole.
    readonly carry: (identifier: string) => Promise<boolean>;
    // Starts the shared daemon again with the owner's own Mutagen, after the move stopped one of another version.
    readonly restartTheirs: () => boolean;
}

// How the old directory answered: its listing, or why there is none.
type Listing = { readonly kind: "listed"; readonly sessions: StoredSession[] } | { readonly kind: "down" | "mismatch" | "unanswered" };

const listingOf = (call: MutagenCall): Listing => {
    if (!call.ok) {
        return { kind: saysVersionMismatch(call.stderr) ? "mismatch" : saysDaemonDown(call.stderr) ? "down" : "unanswered" };
    }
    const parsed = parseJsonOr(call.stdout, undefined);
    // SAFETY: Mutagen's own JSON rendering of its list (null when it holds none); every field read is optional.
    return parsed === undefined ? { kind: "unanswered" } : { kind: "listed", sessions: (parsed as StoredSession[] | null) ?? [] };
};

const listed = (seams: MoveSeams, kind: "sync" | "forward", autostart = false): Listing =>
    listingOf(seams.shared([kind, "list", "--template", "{{json .}}"], autostart));

// The old directory's sessions and forwards, and how its daemon came to answer: running already, started by the move
// (it was down), or started by the move in place of a daemon of another version.
interface Opened {
    readonly sync: StoredSession[];
    readonly forwards: StoredSession[];
    readonly startedByMove: boolean;
    readonly displaced: boolean;
}

export const openShared = (seams: MoveSeams): Opened | undefined => {
    const first = listed(seams, "sync");
    let sync: Listing = first;
    if (first.kind === "mismatch") {
        seams.shared(["daemon", "stop"]);
    }
    if (first.kind === "mismatch" || first.kind === "down") {
        sync = listed(seams, "sync", true);
    }
    const forwards = sync.kind === "listed" ? listed(seams, "forward") : undefined;
    if (sync.kind !== "listed" || forwards?.kind !== "listed") {
        return undefined;
    }
    return { sync: sync.sessions, forwards: forwards.sessions, startedByMove: first.kind !== "listed", displaced: first.kind === "mismatch" };
};

// What moving the sessions came to: which were carried, the paused ones left for the watcher to make again (whose pause
// it carries over), and whether everything of this agent's in the old directory ended.
export interface Moved {
    readonly carried: readonly MovingSession[];
    readonly remade: readonly MovingSession[];
    readonly ended: boolean;
}

// Each session's state into this agent's own directory, once the old daemon has stopped syncing them: the ones carried.
const carrySessions = async (seams: MoveSeams, plan: MovePlan): Promise<MovingSession[]> => {
    const running = plan.sync.filter((session) => !session.paused);
    // Paused first, so nothing changes under the copy and the old daemon never syncs beside the new one. A pause refused
    // carries nothing: those sessions are only ended and made again.
    const still = running.length === 0 || seams.shared(["sync", "pause", ...running.map((session) => session.target)]).ok;
    if (!still || plan.sync.length === 0 || !seams.startOwn()) {
        return [];
    }
    // A name this agent's daemon already holds (made by a run whose move had not gone through) is not carried beside it;
    // nor is any while it could not be asked.
    const names = plan.sync.map((session) => session.name);
    const held = new Set(seams.ownSessions(names) ?? names);
    const carried: MovingSession[] = [];
    for (const session of plan.sync.filter((candidate) => !held.has(candidate.name))) {
        // one session's files at a time
        if (session.identifier !== undefined && (await seams.carry(session.identifier))) {
            carried.push(session);
        }
    }
    return carried;
};

// The daemon reads its sessions as it starts: started again, it holds the carried ones, paused as they were left; what
// was running runs again.
const loadCarried = (seams: MoveSeams, carried: readonly MovingSession[]): void => {
    if (carried.length === 0) {
        return;
    }
    seams.own(["daemon", "stop"]);
    seams.startOwn();
    const resume = carried.filter((session) => !session.paused).map((session) => session.name);
    if (resume.length > 0) {
        seams.own(["sync", "resume", ...resume]);
    }
};

export const moveSessions = async (seams: MoveSeams, plan: MovePlan): Promise<Moved> => {
    const carried = await carrySessions(seams, plan);
    const ended =
        (plan.sync.length === 0 || seams.shared(["sync", "terminate", ...plan.sync.map((session) => session.target)]).ok) &&
        (plan.terminateForwards.length === 0 || seams.shared(["forward", "terminate", ...plan.terminateForwards]).ok);
    loadCarried(seams, carried);
    return { carried, remade: plan.sync.filter((session) => !carried.includes(session)), ended };
};

// Whether Mutagen's own sign-in registration (its Run value on Windows, its LaunchAgent on macOS) starts this agent's
// copy: what only this agent's older `sync setup` wrote, where it had no launch stub. Pure.
export const registrationIsOurs = (registration: string | undefined, own: string, platform: NodeJS.Platform): boolean => {
    if (registration === undefined) {
        return false;
    }
    const fold = (text: string): string => (platform === "win32" ? text.replaceAll("/", "\\").toLowerCase() : text);
    return fold(registration).includes(fold(own));
};

// The directory the old builds used: Mutagen's default unless this process was told another, as the old builds were.
const sharedDataDir = (): string => process.env["MUTAGEN_DATA_DIRECTORY"] ?? join(homeDir(), ".mutagen");

// The environment old builds ran Mutagen with, autostart off unless this call is meant to start the old daemon.
const sharedEnv = (autostart: boolean): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    delete env["MUTAGEN_DISABLE_AUTOSTART"];
    return autostart ? env : { ...env, MUTAGEN_DISABLE_AUTOSTART: "1" };
};

// The two state files Mutagen keeps for a sync session, both named by its identifier: the session itself and the last
// state both sides agreed on (absent until its first cycle). Its scan caches are rebuilt by the first scan.
const STATE_FOLDERS = ["sessions", "archives"] as const;

// Copies one session's state files from `from` into this agent's own directory: false, with nothing left behind, when
// the session file is not there or a copy failed.
export const carryState = async (from: string, to: string, identifier: string): Promise<boolean> => {
    if (!existsSync(join(from, "sessions", identifier))) {
        return false;
    }
    const present = STATE_FOLDERS.filter((folder) => existsSync(join(from, folder, identifier)));
    try {
        for (const folder of present) {
            // two small files, in order
            await mkdir(join(to, folder), { recursive: true });
            await copyFile(join(from, folder, identifier), join(to, folder, identifier));
        }
        return true;
    } catch {
        // allow(silent-catch): a session whose state could not be copied is made again instead; a half copy must not load
        await Promise.all(STATE_FOLDERS.map(async (folder) => await rm(join(to, folder, identifier), { force: true })));
        return false;
    }
};

const realSeams = (mutagen: string, from: string): MoveSeams => ({
    shared: (args, autostart = false) => {
        const ran = runProcessSync(mutagen, args, { timeoutMs: MUTAGEN_CALL_TIMEOUT_MS, env: sharedEnv(autostart) });
        return { ok: ran.status === 0, stdout: ran.stdout, stderr: ran.stderr };
    },
    own: (args) => runProcessSync(mutagen, args, { timeoutMs: MUTAGEN_CALL_TIMEOUT_MS, quiet: true }).status === 0,
    startOwn: () => startMutagenDaemon(mutagen),
    ownSessions: (names) => existingSyncSessions(mutagen, names),
    carry: async (identifier) => await carryState(from, mutagenDataDir, identifier),
    restartTheirs: () => {
        const theirs = resolveOnPath("mutagen");
        if (theirs === undefined || theirs.toLowerCase() === ownMutagenPath().toLowerCase()) {
            return false;
        }
        return runProcessSync(theirs, ["daemon", "start"], { timeoutMs: MUTAGEN_CALL_TIMEOUT_MS, env: sharedEnv(true), quiet: true }).status === 0;
    },
});

const WINDOWS_RUN_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const LAUNCH_AGENT = join(homeDir(), "Library", "LaunchAgents", "io.mutagen.mutagen.plist");

// Mutagen's own registration, as text, where this platform keeps one.
const mutagenRegistration = async (): Promise<string | undefined> => {
    if (process.platform === "win32") {
        // allow(silent-catch): an unreadable Run value is taken for none; this agent's own copy is then not started by it either way
        return (await readRegistryValue(WINDOWS_RUN_KEY, "Mutagen").catch(() => undefined))?.data;
    }
    return process.platform === "darwin" ? await readTextIfExists(LAUNCH_AGENT) : undefined;
};

const retireOldRegistrations = async (seams: MoveSeams, log: Log): Promise<void> => {
    if (process.platform === "win32") {
        clearWindowsRunValue(MUTAGEN_RUN_VALUE);
    }
    if (registrationIsOurs(await mutagenRegistration(), ownMutagenPath(), process.platform)) {
        seams.shared(["daemon", "unregister"]);
        log("removed the sign-in entry that started this agent's Mutagen over the shared data directory.");
    }
};

// Moves this environment's Mutagen state off the shared directory, once; a no-op after that and wherever there is no
// such directory. Touches only this agent's own sessions there, and leaves every synced folder's files where they are.
export const moveOffSharedMutagen = async (mutagen: string, log: Log, seams?: MoveSeams): Promise<void> => {
    if (await movedAlready()) {
        return;
    }
    const from = sharedDataDir();
    if (!existsSync(from) || from === mutagenDataDir) {
        await recordMove([]);
        return;
    }
    const acts = seams ?? realSeams(mutagen, from);
    const opened = openShared(acts);
    if (opened === undefined) {
        log(`the Mutagen state this agent kept in ${from} could not be read, so its sessions there are left until its next start.`);
        return;
    }
    const plan = movePlan(opened.sync, opened.forwards, sessionOwner());
    const moved = await moveSessions(acts, plan);
    if (stopsOldDaemon(plan, opened.startedByMove)) {
        acts.shared(["daemon", "stop"]);
        if (!plan.othersRemain) {
            await retireOldRegistrations(acts, log);
        } else if (opened.displaced && !acts.restartTheirs()) {
            log(`the Mutagen daemon over ${from} was another version than this agent's and is stopped; your own Mutagen starts it again the next time you use it.`);
        }
    } else if (process.platform === "win32") {
        clearWindowsRunValue(MUTAGEN_RUN_VALUE);
    }
    if (!moved.ended) {
        log(`this agent's sessions in ${from} did not all end, so moving off it is tried again at the next start.`);
        return;
    }
    const count = plan.sync.length + plan.terminateForwards.length;
    if (count > 0) {
        log(
            `moved off Mutagen's shared data directory (${from}): carried ${moved.carried.length} of this agent's ${plan.sync.length} sync session(s) to ${mutagenDataDir} with what they had synced${moved.remade.length > 0 ? `, the rest are made again there` : ""}, and ended its ${plan.terminateForwards.length} forward(s), which are made again${plan.othersRemain ? ". Everything else in it is left running" : ""}.`,
        );
    }
    await recordMove(moved.remade.filter((session) => session.paused).map((session) => session.name));
};
