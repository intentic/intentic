import { writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { readJsonIfExists, readTextIfExistsSync, writeFileAtomic } from "@intentic/base/fs";
import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";
import { baseDir } from "../config.js";

/* WHY THE AGENT BEFORE THIS ONE ENDED (2026-10-11). An agent that came back after a watchdog kill, an update, a stop or a
   crash looked the same as one that never left: the reason was one line somewhere in machine.log, if anything wrote it
   at all (Windows ends a stopped process without running its handlers). So every way out records itself in one small
   file before it goes: the agent's own exits, the watchdog's kill (from its thread, the one thing still running then),
   and whoever stops the agent from outside (supervision.ts), keyed by pid so a process never answers for another. The
   next agent reads it once at start, says it in its log and in `describe`, and starts its own record. A record still
   "running" was killed by something that said nothing (power, the OS, an out-of-memory kill), and the time it was last
   alive against the machine's own boot time tells a restart of the computer (or of WSL) from that. */

export const lastExitPath = join(baseDir, "last-exit.json");

export const EXIT_REASONS = ["running", "watchdog", "crash", "exited", "stopped", "restart", "update", "replaced", "retired"] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

const ExitRecordSchema = z.object({
    pid: z.number(),
    version: z.string(),
    startedAt: z.string(),
    reason: z.string(),
    // When it ended, and the one line that says how (a signal, an exit code, the error, the stall).
    at: z.string().optional(),
    detail: z.string().optional(),
    // Stamped every tick while it runs: how a record left "running" says when the agent was last seen alive.
    aliveAt: z.string().optional(),
});
export type ExitRecord = z.infer<typeof ExitRecordSchema>;

// No record (a first start) or a torn one says nothing about the agent before.
export const readExitRecordSync = (path: string = lastExitPath): ExitRecord | undefined => {
    const text = readTextIfExistsSync(path);
    return text === undefined ? undefined : parseJsonWith(text, ExitRecordSchema);
};

const readExitRecord = async (path: string): Promise<ExitRecord | undefined> => await readJsonIfExists(path, ExitRecordSchema);

// How an exit reads in the record: the reason, and the one line that says how.
export interface ExitCause {
    readonly reason: ExitReason;
    readonly detail: string;
}

// How an exit code of this agent reads (resident.ts): 128+n is a signal, 75 another agent took over, 76 a roll-back.
export const reasonForCode = (code: number): ExitCause => {
    if (code === 0) {
        return { reason: "retired", detail: "nothing left to serve" };
    }
    if (code === 75) {
        return { reason: "replaced", detail: "another agent took this environment over" };
    }
    if (code === 129 || code === 130 || code === 143) {
        return { reason: "stopped", detail: `signal ${{ 129: "SIGHUP", 130: "SIGINT", 143: "SIGTERM" }[code]}` };
    }
    return { reason: "crash", detail: `exit code ${code}` };
};

const REASON_TEXT = {
    running: "it ended without recording why",
    watchdog: "its watchdog killed it, the event loop having stopped answering",
    crash: "it crashed",
    exited: "it exited",
    stopped: "it was stopped",
    restart: "it was restarted",
    update: "it was restarted for an update",
    replaced: "another agent took this environment over",
    retired: "it had nothing left to serve",
} satisfies Record<ExitReason, string>;

const ExitReasonSchema = z.enum(EXIT_REASONS);

// The sentence a start says about the agent before it. `uptimeMs` is how long this computer (or this WSL distro's VM)
// has been up: a record left "running" from before the boot was ended by the restart. Pure.
export const exitSentence = (record: ExitRecord, now: number, uptimeMs: number): string => {
    const who = `the agent before this one (pid ${record.pid}, ${record.version}, started ${record.startedAt})`;
    if (record.reason !== "running") {
        const known = ExitReasonSchema.safeParse(record.reason);
        const why = known.success ? REASON_TEXT[known.data] : record.reason;
        return `${who} ended${record.at === undefined ? "" : ` at ${record.at}`}: ${why}${record.detail === undefined ? "" : ` (${record.detail})`}.`;
    }
    const alive = record.aliveAt ?? record.startedAt;
    const bootedAt = now - uptimeMs;
    if (Date.parse(alive) < bootedAt) {
        return `${who} was last alive at ${alive} and the computer has booted since (${new Date(bootedAt).toISOString()}): a restart, shutdown or power loss ended it.`;
    }
    return `${who} was last alive at ${alive} and ended without recording why: killed from outside (the OS, an out-of-memory kill, a task manager), not by a stop of its own tools.`;
};

// What the previous run left, read once at this one's start; describe says it while this agent runs.
let previous: { readonly record: ExitRecord; readonly sentence: string } | undefined;
let mine: ExitRecord | undefined;

export const previousExit = (): string | undefined => previous?.sentence;
export const thisRun = (): ExitRecord | undefined => mine;

const writeSafely = (path: string, record: ExitRecord): void => {
    try {
        writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch (error) {
        // allow(terminal-output): a line of the resident agent's own log, which its supervisor captures from stderr
        process.stderr.write(`could not record why the agent ends in ${path} (${errorMessage(error)})\n`);
    }
};

// Read what the agent before left, then start this one's record. Answers the sentence to log, when there was a record.
export const beginExitRecord = async (
    pid: number,
    version: string,
    { path = lastExitPath, now = Date.now(), uptimeMs = uptime() * 1000 }: { readonly path?: string; readonly now?: number; readonly uptimeMs?: number } = {},
): Promise<string | undefined> => {
    const before = await readExitRecord(path);
    previous = before === undefined || before.pid === pid ? undefined : { record: before, sentence: exitSentence(before, now, uptimeMs) };
    mine = { pid, version, startedAt: new Date(now).toISOString(), reason: "running" };
    await writeFileAtomic(path, `${JSON.stringify(mine)}\n`);
    return previous?.sentence;
};

// Stamped every tick, so a record nobody closed still says when its agent was last seen. Best-effort.
export const stampAlive = async (path: string = lastExitPath, now: number = Date.now()): Promise<void> => {
    if (mine === undefined) {
        return;
    }
    const current = await readExitRecord(path);
    // A record another process now holds, or one already closed (a stop recorded from outside), is left alone.
    if (current !== undefined && (current.pid !== mine.pid || current.reason !== "running")) {
        return;
    }
    // allow(silent-catch): a missed stamp only makes "last alive" older by one tick
    await writeFileAtomic(path, `${JSON.stringify({ ...mine, aliveAt: new Date(now).toISOString() })}\n`).catch(() => undefined);
};

// This process ends, for `reason`: written synchronously (an exit handler cannot wait), and only over this process's own
// record still open, so a stop recorded from outside (an update) is not overwritten by the signal that carried it out.
export const recordExit = (reason: ExitReason, detail: string | undefined, { path = lastExitPath, at = new Date() }: { readonly path?: string; readonly at?: Date } = {}): void => {
    if (mine === undefined) {
        return;
    }
    const current = readExitRecordSync(path);
    if (current !== undefined && (current.pid !== mine.pid || current.reason !== "running")) {
        return;
    }
    const closed: ExitRecord = { ...mine, reason, at: at.toISOString() };
    if (current?.aliveAt !== undefined) {
        closed.aliveAt = current.aliveAt;
    }
    if (detail !== undefined) {
        closed.detail = detail;
    }
    writeSafely(path, closed);
};

// Whoever stops the agent `pid` from outside says why first: on Windows the agent runs none of its handlers then.
export const recordStopFor = (pid: number, reason: "stopped" | "restart" | "update", detail: string, { path = lastExitPath, at = new Date() }: { readonly path?: string; readonly at?: Date } = {}): void => {
    const current = readExitRecordSync(path);
    if (current?.pid !== pid || current.reason !== "running") {
        return;
    }
    writeSafely(path, { ...current, reason, at: at.toISOString(), detail });
};

// The last ways out an agent has without a word of its own: an uncaught error, and an exit nobody recorded. The 'exit'
// handler runs for both, synchronously; the monitor only remembers the error for it.
export const recordUnexpectedExits = (): void => {
    let crashed: string | undefined;
    process.on("uncaughtExceptionMonitor", (error) => {
        crashed = errorMessage(error);
    });
    process.on("exit", (code) => {
        if (crashed !== undefined) {
            recordExit("crash", crashed.slice(0, 300));
        } else {
            recordExit(code === 0 ? "exited" : "crash", `exit code ${code}`);
        }
    });
};
