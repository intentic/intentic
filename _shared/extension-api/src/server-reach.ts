import type { CiFeedEvent } from "@intentic/sandbox-contract/schemas/ci";

// What a backend (and a declared process) hears, holds, runs and writes beside its routes (`ExtensionServerApi`'s
// `events`, `exec`, `activity` and `sleep`, server.ts), split from server.ts to keep each file one reading.

// (2026-11-26) A run ending in a conversation this extension started (POST /agent with its own token), as
// `api.events.onRunSettled` hears it. `stopped`: a person's stop or a parent's cancel ended it, not the turn itself.
export interface RunSettled {
    readonly conversationId: string;
    // Which run of the conversation it was.
    readonly run: string;
    readonly outcome: "done" | "failed" | "stopped";
    readonly error?: string | undefined;
    // Its last top-level prose, empty when it said nothing (cut at 20 000 characters).
    readonly closing: string;
}

// Whether any agent turn is running in the sandbox, as `api.events.onActivity` hears it.
export interface SandboxActivity {
    readonly live: boolean;
}

// (2026-11-26) What the forges said, as the core's CI ingestion heard it (`api.events.onCi`): a run that finished, or a
// job that ended, with what the forge said of a failed job's failure. The CI feed's own frame (GET /ci/feed).
export type { CiFeedEvent };

// (2026-11-26) A row in the sandbox's activity feed, written as this extension's own (`api.activity.append`): `type` is
// dotted like the sandbox's own rows (`ci.repair_started`), `content` the sentence a person reads.
export interface ActivityRow {
    readonly type: string;
    readonly content: string;
    readonly outcome?: "ok" | "error" | undefined;
    readonly conversationId?: string | undefined;
}

// The workload classes `api.exec` runs under, each declared in `permissions.exec`: `command`, admitted and ranked as an
// agent's shell command; `toolchain`, a heavy tool, which also takes turns in the sandbox's heavy-command queue.
export type ExecClass = "command" | "toolchain";

export interface ExecOptions {
    // `command` when absent.
    readonly class?: ExecClass;
    // Absolute, or relative to the workspace root; the workspace root when absent.
    readonly cwd?: string;
    // Laid over the daemon's environment.
    readonly env?: Readonly<Record<string, string>>;
    readonly stdin?: string;
    // How long it may take, waiting for room or a queue slot included: 10 minutes when absent, at most 2 hours.
    readonly timeoutMs?: number;
    // Bytes kept per stream, 1 MiB when absent, at most 64 MiB; past it the stream is still read and `truncated` says so.
    readonly outputBytes?: number;
    // Which end of an overflowing stream is kept: the head when absent.
    readonly keep?: "head" | "tail";
    // What the queue and the process list call it, after the extension's name.
    readonly label?: string;
    // Ends it, as its deadline does.
    readonly signal?: AbortSignal;
}

export interface ExecResult {
    // Set when the sandbox did not start it: no room came free within its deadline. Nothing ran.
    readonly refused?: string | undefined;
    // How long it waited for room before it started; a queued `toolchain` run waits inside its own run instead.
    readonly waitedMs: number;
    // Absent when it did not exit by itself: ended (`ended`), never started (`spawnError`), or killed by a signal.
    readonly exitCode?: number | undefined;
    readonly signal?: string | undefined;
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated: boolean;
    readonly ended?: "timeout" | "aborted" | undefined;
    readonly spawnError?: string | undefined;
}

// (2026-11-27) The hosted machine about to sleep, as `api.sleep.beforeSleep` hears it: the moment (ms) after which it
// stops whether or not every handler finished.
export interface SleepNotice {
    readonly deadline: number;
}

export type SleepHandler = (notice: SleepNotice) => Promise<void> | void;

// (2026-11-27) What a boot follows, as `api.sleep.boot()` answers it.
export interface SleepBoot {
    // The daemon stopped last time because the hosted machine went to sleep: the before-sleep handlers ran.
    readonly afterSleep: boolean;
    // The platform started this machine for a request at one of its wake doors (a webhook's, or a `wakes` route's).
    readonly requestWake: boolean;
}

// (2026-11-27) Where one message is that the platform's sleep watch heard for one of this extension's connections while
// the sandbox slept, as `api.sleep.heard()` answers it: ids only, never what it says.
export interface SleepHeardMessage {
    // The service the platform held the connection on (`discord`).
    readonly service: string;
    // The card's id in this sandbox.
    readonly connection: string;
    readonly channelId: string;
    readonly messageId: string;
    // The server it was written in; absent for a direct message.
    readonly guildId?: string | undefined;
    // When the platform heard it (ms).
    readonly at: number;
}
