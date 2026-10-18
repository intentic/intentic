import { existsSync } from "node:fs";
import { join } from "node:path";
import { readTextIfExists } from "@intentic/base/fs";
import { parseJsonOr } from "@intentic/base/json";
import { clearWindowsRunValue, homeDir, type Log } from "@intentic/local-agent";
import { readRegistryValue } from "../windows-registry.js";
import { sessionOwner } from "./environment.js";
import { runProcessSync } from "./exec.js";
import { MUTAGEN_CALL_TIMEOUT_MS, MUTAGEN_RUN_VALUE, ownershipOf, ownMutagenPath, SESSION_PREFIX } from "./mutagen.js";
import { movedAlready, mutagenDataDir, recordMove } from "./mutagen-env.js";

/* OFF MUTAGEN'S SHARED DATA DIRECTORY, once (2026-10-18). Builds before mutagen-env.ts kept this agent's sessions and
   forwards in the user's own `~/.mutagen` (or wherever their MUTAGEN_DATA_DIRECTORY pointed), under a daemon they share
   with any Mutagen of their own. Moving is ending them there: each running sync session of this agent's is flushed
   (bounded), then every session and forward of its own is terminated through the old directory; the watcher then makes
   them again from its pairings under the new one, as it makes any missing session (mutagen.ts convergeSession). A
   two-way-safe session made over two folders that already agree only rescans them; a pause carries over (below).
   What is this agent's is said strictly as every sweep here says it: a name under its prefix that no other owner's
   label claims (mutagen.ts ownershipOf). The old daemon is stopped only when nothing else is left in it, or when this
   move is what started it; a daemon still holding the user's own sessions keeps running. Mutagen's own sign-in
   registration goes only where it starts this agent's copy, which only this agent's older builds wrote. */

// What `sync list` and `forward list` print of one session under `{{json .}}`, as far as the move reads it.
export interface StoredSession {
    readonly name?: string;
    readonly identifier?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly paused?: boolean;
}

export interface MovePlan {
    // This agent's running sync sessions, by identifier: flushed before they end.
    readonly flush: readonly string[];
    readonly terminateSync: readonly string[];
    readonly terminateForwards: readonly string[];
    // This agent's sync sessions that were paused, by name: made paused again under the new directory.
    readonly paused: readonly string[];
    // Whether anything not this agent's is in the old directory.
    readonly othersRemain: boolean;
}

const ours = (session: StoredSession, owner: string): boolean =>
    session.name?.startsWith(SESSION_PREFIX) === true && ownershipOf(session.labels, owner) !== "theirs";

// What ending this agent's part of the old directory takes. Pure.
export const movePlan = (sync: readonly StoredSession[], forwards: readonly StoredSession[], owner: string): MovePlan => {
    const target = (session: StoredSession): string[] => {
        const id = session.identifier ?? session.name;
        return id === undefined ? [] : [id];
    };
    const mine = sync.filter((session) => ours(session, owner));
    const mineForwards = forwards.filter((session) => ours(session, owner));
    return {
        flush: mine.filter((session) => session.paused !== true).flatMap(target),
        terminateSync: mine.flatMap(target),
        terminateForwards: mineForwards.flatMap(target),
        paused: mine.filter((session) => session.paused === true).flatMap((session) => (session.name === undefined ? [] : [session.name])),
        othersRemain: mine.length < sync.length || mineForwards.length < forwards.length,
    };
};

// Whether the old daemon goes once this agent's sessions have: when nothing else is in it, or when the move started it
// and so leaves it as it found it. Pure.
export const stopsOldDaemon = (plan: Pick<MovePlan, "othersRemain">, startedByMove: boolean): boolean => !plan.othersRemain || startedByMove;

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

const shared = (mutagen: string, args: readonly string[], autostart = false) => {
    const ran = runProcessSync(mutagen, args, { timeoutMs: MUTAGEN_CALL_TIMEOUT_MS, env: sharedEnv(autostart) });
    return { ok: ran.status === 0, stdout: ran.stdout };
};

// One listing as `{{json .}}` prints it, or undefined when it did not answer.
const listed = (mutagen: string, kind: "sync" | "forward", autostart = false): StoredSession[] | undefined => {
    const ran = shared(mutagen, [kind, "list", "--template", "{{json .}}"], autostart);
    const parsed = ran.ok ? parseJsonOr(ran.stdout, undefined) : undefined;
    // SAFETY: Mutagen's own JSON rendering of its list (null when it holds none); every field read is optional.
    return parsed === undefined ? undefined : ((parsed as StoredSession[] | null) ?? []);
};

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

const retireOldRegistrations = async (mutagen: string, log: Log): Promise<void> => {
    if (process.platform === "win32") {
        clearWindowsRunValue(MUTAGEN_RUN_VALUE);
    }
    if (registrationIsOurs(await mutagenRegistration(), ownMutagenPath(), process.platform)) {
        shared(mutagen, ["daemon", "unregister"]);
        log("removed the sign-in entry that started this agent's Mutagen over the shared data directory.");
    }
};

// Moves this environment's Mutagen state off the shared directory, once; a no-op after that and wherever there is no
// such directory. Ends only this agent's own sessions there, and leaves every synced folder's files where they are.
export const moveOffSharedMutagen = async (mutagen: string, log: Log): Promise<void> => {
    if (await movedAlready()) {
        return;
    }
    const from = sharedDataDir();
    if (!existsSync(from) || from === mutagenDataDir) {
        await recordMove([]);
        return;
    }
    // Asked first without starting anything: a daemon that answers was running before the move, one that does not is
    // started by asking again, and stopped again below.
    const running = listed(mutagen, "sync");
    const sync = running ?? listed(mutagen, "sync", true);
    const startedByMove = running === undefined;
    const forwards = sync === undefined ? undefined : listed(mutagen, "forward");
    if (sync === undefined || forwards === undefined) {
        log(`the Mutagen state this agent kept in ${from} could not be read, so its sessions there are left until its next start.`);
        return;
    }
    const plan = movePlan(sync, forwards, sessionOwner());
    // A flush that runs out (a sandbox not answering) is no reason to keep the old session: both folders keep their
    // files, and the new session compares them.
    if (plan.flush.length > 0) {
        shared(mutagen, ["sync", "flush", ...plan.flush]);
    }
    const ended =
        (plan.terminateSync.length === 0 || shared(mutagen, ["sync", "terminate", ...plan.terminateSync]).ok) &&
        (plan.terminateForwards.length === 0 || shared(mutagen, ["forward", "terminate", ...plan.terminateForwards]).ok);
    if (stopsOldDaemon(plan, startedByMove)) {
        shared(mutagen, ["daemon", "stop"]);
        if (!plan.othersRemain) {
            await retireOldRegistrations(mutagen, log);
        }
    } else if (process.platform === "win32") {
        clearWindowsRunValue(MUTAGEN_RUN_VALUE);
    }
    if (!ended) {
        log(`this agent's sessions in ${from} did not all end, so moving off it is tried again at the next start.`);
        return;
    }
    const count = plan.terminateSync.length + plan.terminateForwards.length;
    if (count > 0) {
        log(
            `moved off Mutagen's shared data directory (${from}): ended this agent's ${count} session(s) there${plan.othersRemain ? ", leaving everything else in it running" : ""}. They are made again under ${mutagenDataDir}.`,
        );
    }
    await recordMove(plan.paused);
};
