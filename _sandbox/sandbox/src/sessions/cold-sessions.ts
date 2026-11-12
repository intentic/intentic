import type { Stats } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import type { Logger } from "pino";
import type { ConversationActors } from "../conversations/actor/conversation-actors.js";
import type { PersistedAgent } from "../conversations/registry/agents-store.js";
import { type Chore, DAY_MS, HOUR_MS } from "../system/chore-clock.js";
import { type ColdFile, forgetWantedBefore, freezeSession, wantedAt } from "./session-freeze.js";

/* CLAUDE SESSIONS NOBODY HAS TOUCHED IN A WEEK, KEPT COMPRESSED (2026-11-12). On shinobi-society the shared store's
   `records/sessions/claude/projects/` under the state dir held 6.6 GB, 4.1 GB of it raw `.jsonl` (session transcripts and their
   `<session>/subagents/agent-*.jsonl`) that nothing had written for more than 7 days; JSONL like it compresses about
   10x. The daemon's own transcripts were already kept as zstd (sessions/transcript-record.ts); Claude Code's were not.
   So, hourly, every session in the shared store whose files have all sat unwritten for a week, that no conversation is
   running, queued, held or armed on, that the history list does not show, that no reader in this process asked for
   within the week and that no process holds open, has those files compressed in place (session-freeze.ts), and every
   reader thaws a session back before it opens it. Only the shared store: a fenced conversation's own store and a jail
   store are left plain. Anything in doubt is left plain; the next pass looks again.

   One reader is outside the daemon: iq's session recall (`iq sessions`) indexes `~/.claude/projects/<workspace slug>/`
   itself, the folder (`-work`) that holds nearly all the cold bytes, and used to delete every session whose plain file
   was gone. Since 2026-11-12 it reads `.jsonl.zst` too (`_search/iq/src/recall/ingest/ingest.ts`, `fork.ts`), which is
   what let this be scheduled (bootstrap/boot-chores.ts). */

// A session's files must all be this old, by mtime, before they are compressed; see the shinobi numbers above.
export const COLD_SESSION_MS = 7 * DAY_MS;

// The most plain bytes one pass compresses: a store with a backlog (shinobi's 4.1 GB) is worked down over a few hourly
// passes rather than holding zlib's threads for one long one.
const PASS_BYTES = 2 * 1024 ** 3;

// Only names that are plainly the CLI's own session ids are compressed; anything else in a project folder is not ours.
const SESSION_FILE = /^([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.jsonl$/u;
const SESSION_DIR = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;
// A subagent's record directly under `subagents/`: a deeper one (the SDK can file one so) is never compressed, so a
// thaw never has to look for one.
const SUBAGENT_FILE = /^agent-[\w-]+\.jsonl$/u;

// How long one reading of the open files stands before a pass reads them again.
const OPEN_FILES_FRESH_MS = 60_000;

/** What may resume a session with nobody pressing anything, read off the registry and the conversations' actors. */
export interface SessionHolders {
    readonly agents: {
        readonly ids: () => readonly string[];
        readonly entry: (id: string) => Pick<PersistedAgent, "sessionId" | "queue" | "limitHold"> | undefined;
    };
    readonly conversations: Pick<ConversationActors, "liveSessionIds" | "sessionIdOf" | "state" | "stranded">;
}

/**
 * Every session a turn is running on, or that a conversation may resume by itself: one with words queued or booked, a
 * held turn (a weekly allowance holds one about as long as a session takes to go cold), an armed watch, a recovery
 * under way, a cache kept warm. Their files stay plain however long ago they were written.
 */
export const busySessions = (holders: SessionHolders): Set<string> => {
    const busy = new Set(holders.conversations.liveSessionIds());
    const add = (sessionId: string | undefined): void => {
        if (sessionId !== undefined) {
            busy.add(sessionId);
        }
    };
    for (const { record } of holders.conversations.stranded()) {
        add(record.sessionId);
    }
    for (const id of holders.agents.ids()) {
        const entry = holders.agents.entry(id);
        const state = holders.conversations.state(id);
        const stored = (entry?.queue?.items.length ?? 0) > 0 || entry?.limitHold !== undefined;
        const live =
            state !== undefined &&
            (state.phase.kind !== "idle" ||
                state.queue.items.length > 0 ||
                state.resume.held !== undefined ||
                state.turn.resuming ||
                state.watches.length > 0 ||
                state.keepWarm !== undefined);
        if (stored || live) {
            add(entry?.sessionId);
            add(holders.conversations.sessionIdOf(id));
            add(state?.resume.held?.sessionId);
        }
    }
    return busy;
};

/**
 * Every path under `root` that some process holds open, read off /proc; undefined where /proc cannot be listed (not
 * Linux), which the sweep takes as doubt about everything. `root` must be a real path: /proc names files resolved.
 */
const openPathsUnder = async (root: string): Promise<ReadonlySet<string> | undefined> => {
    const pids = await readdir("/proc").catch(undefinedIfMissing);
    if (pids === undefined) {
        return undefined;
    }
    const prefix = `${root}/`;
    const open = new Set<string>();
    await Promise.all(
        pids
            .filter((name) => /^\d+$/u.test(name))
            .map(async (pid) => {
                // allow(silent-catch): a process that ended meanwhile (ENOENT), or another user's this one may not look
                // into (EACCES), holds nothing this daemon's turns opened.
                const fds = await readdir(`/proc/${pid}/fd`).catch(() => []);
                for (const fd of fds) {
                    // one process's descriptors at a time; the processes themselves are read side by side
                    // allow(silent-catch): a descriptor closed between the listing and the read names nothing open.
                    const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => undefined);
                    if (target?.startsWith(prefix) === true) {
                        open.add(target);
                    }
                }
            }),
    );
    return open;
};

export interface ColdSessionsDeps {
    // The shared Claude store (sessions/session-store.ts sharedClaudeStore).
    readonly store: string;
    readonly busy: () => ReadonlySet<string>;
    // The sessions the history list shows (sessions.ts listedSessionIds): the SDK lists only plain transcripts, so
    // these stay plain whatever their age, and the list reads as it did.
    readonly listed: () => Promise<readonly string[]>;
    readonly logger: Pick<Logger, "info" | "warn" | "debug">;
    readonly now?: () => number;
    readonly openFiles?: (root: string) => Promise<ReadonlySet<string> | undefined>;
}

export interface ColdPass {
    // Sessions some of whose files were compressed, and those files.
    readonly sessions: number;
    readonly files: number;
    readonly bytesIn: number;
    readonly bytesOut: number;
    // Sessions a write failed on, with why: their files stay plain, and the next pass tries again.
    readonly failed: readonly { readonly sessionId: string; readonly error: string }[];
    // Why the pass compressed nothing at all, when something stopped it before it looked.
    readonly held?: string;
}

const NOTHING: ColdPass = { sessions: 0, files: 0, bytesIn: 0, bytesOut: 0, failed: [] };

// One session's plain files in one project folder, its subagents' first and its transcript last, as lstat found them.
// Undefined when any is not a plain file or was written within the week, which keeps the whole session plain.
const coldFilesOf = async (dir: string, sessionId: string, plain: boolean, now: number): Promise<ColdFile[] | undefined> => {
    const subagents = join(dir, sessionId, "subagents");
    const names = ((await readdir(subagents).catch(undefinedIfMissing)) ?? []).filter((name) => SUBAGENT_FILE.test(name));
    const paths = [...names.map((name) => join(subagents, name)), ...(plain ? [join(dir, `${sessionId}.jsonl`)] : [])];
    const files: ColdFile[] = [];
    for (const path of paths) {
        // one stat at a time: a session has a transcript and a handful of subagents
        const seen: Stats | undefined = await lstat(path).catch(undefinedIfMissing);
        if (seen === undefined || !seen.isFile() || now - seen.mtimeMs < COLD_SESSION_MS) {
            return undefined;
        }
        files.push({ path, seen });
    }
    return files;
};

// The session ids one project folder holds plain files for: a transcript, or a folder that may hold subagents' records.
const sessionsIn = async (dir: string): Promise<Map<string, boolean>> => {
    const sessions = new Map<string, boolean>();
    for (const entry of (await readdir(dir, { withFileTypes: true }).catch(undefinedIfMissing)) ?? []) {
        const transcript = SESSION_FILE.exec(entry.name)?.[1];
        if (transcript !== undefined && entry.isFile()) {
            sessions.set(transcript, true);
        } else if (entry.isDirectory() && SESSION_DIR.test(entry.name) && !sessions.has(entry.name)) {
            sessions.set(entry.name, false);
        }
    }
    return sessions;
};

interface PassContext {
    readonly listed: ReadonlySet<string>;
    readonly busy: ReadonlySet<string>;
    readonly now: number;
}

// Every session in one project folder that has gone cold and that nothing keeps plain, with its files.
async function* coldSessionsIn(dir: string, context: PassContext): AsyncGenerator<{ readonly sessionId: string; readonly files: ColdFile[] }> {
    for (const [sessionId, plain] of await sessionsIn(dir)) {
        const kept = context.listed.has(sessionId) || context.busy.has(sessionId) || context.now - (wantedAt(sessionId) ?? 0) < COLD_SESSION_MS;
        const files = kept ? undefined : await coldFilesOf(dir, sessionId, plain, context.now);
        if (files !== undefined && files.length > 0) {
            yield { sessionId, files };
        }
    }
}

// The open files as last read, read again once that reading is older than OPEN_FILES_FRESH_MS; undefined is doubt.
const openFilesOf = (read: (root: string) => Promise<ReadonlySet<string> | undefined>, root: string) => {
    let reading: { readonly at: number; readonly open: ReadonlySet<string> | undefined } | undefined;
    return async (): Promise<ReadonlySet<string> | undefined> => {
        if (reading === undefined || Date.now() - reading.at > OPEN_FILES_FRESH_MS) {
            reading = { at: Date.now(), open: await read(root) };
        }
        return reading.open;
    };
};

const OPEN_UNREADABLE = "the open files could not be read";

/** One pass over the shared store's projects, compressing what has gone cold; see the header for what stays. */
export const sweepColdSessions = async (deps: ColdSessionsDeps, now: number): Promise<ColdPass> => {
    const projects = await realpath(join(deps.store, "projects")).catch(undefinedIfMissing);
    if (projects === undefined) {
        return NOTHING;
    }
    forgetWantedBefore(now - COLD_SESSION_MS);
    // Read first, so a list that cannot be read stops the pass before it touches anything.
    const context: PassContext = { listed: new Set(await deps.listed()), busy: deps.busy(), now };
    const open = openFilesOf(deps.openFiles ?? openPathsUnder, projects);
    let pass = { sessions: 0, files: 0, bytesIn: 0, bytesOut: 0 };
    const failed: { sessionId: string; error: string }[] = [];
    const projectDirs = (await readdir(projects, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    for (const project of projectDirs) {
        for await (const { sessionId, files } of coldSessionsIn(join(projects, project.name), context)) {
            const size = files.reduce((sum, file) => sum + file.seen.size, 0);
            if (pass.bytesIn > 0 && pass.bytesIn + size > PASS_BYTES) {
                return { ...pass, failed };
            }
            const held = await open();
            if (held === undefined) {
                return { ...pass, failed, held: OPEN_UNREADABLE };
            }
            if (files.some((file) => held.has(file.path))) {
                continue;
            }
            try {
                // The same week the session was judged by, on the clock thaws stamp: a reader asking at any moment since
                // keeps it plain, including one whose thaw found it plain and handed it on before this took the lock.
                const frozen = await freezeSession(sessionId, files, Math.min(now, Date.now()) - COLD_SESSION_MS);
                pass = {
                    sessions: pass.sessions + Math.min(frozen.files, 1),
                    files: pass.files + frozen.files,
                    bytesIn: pass.bytesIn + frozen.bytesIn,
                    bytesOut: pass.bytesOut + frozen.bytesOut,
                };
            } catch (error) {
                failed.push({ sessionId, error: errorMessage(error) });
            }
        }
    }
    return { ...pass, failed };
};

const MB = 1024 * 1024;

// Hourly; root-scoped like the other store sweeps, since a guest sharing the workspace must not compress its sessions.
export const coldSessionsChore = (deps: ColdSessionsDeps): Chore => ({
    name: "cold-sessions",
    everyMs: HOUR_MS,
    run: async () => {
        const pass = await sweepColdSessions(deps, (deps.now ?? Date.now)());
        if (pass.files > 0) {
            deps.logger.info(
                { sessions: pass.sessions, files: pass.files, fromMb: Math.round(pass.bytesIn / MB), toMb: Math.round(pass.bytesOut / MB) },
                "sessions: compressed Claude sessions nobody touched in a week",
            );
        }
        if (pass.failed.length > 0) {
            deps.logger.warn({ count: pass.failed.length, first: pass.failed[0] }, "sessions: some cold Claude sessions could not be compressed");
        }
        if (pass.held !== undefined) {
            deps.logger.debug({ held: pass.held }, "sessions: cold Claude sessions left as they are");
        }
    },
});
