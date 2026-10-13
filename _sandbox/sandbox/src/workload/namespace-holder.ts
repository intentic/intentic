import { readFileSync } from "node:fs";
import { sleep } from "@intentic/base/async";
import type { NamespaceEntryReference } from "./namespace-entry.js";
import { forgetNamespaceEntry } from "./namespace-entry.js";

interface NamespaceOutput {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
    off(event: "data", listener: (chunk: Buffer) => void): unknown;
}

// A structural process seam: fake-data tests exercise holder loss without spawning unshare or bubblewrap.
export interface NamespaceHolder {
    readonly pid?: number | undefined;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    readonly stdout: NamespaceOutput | null;
    readonly stderr: NamespaceOutput | null;
    once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    once(event: "error", listener: (error: Error) => void): unknown;
    off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    off(event: "error", listener: (error: Error) => void): unknown;
}

// Installed as soon as the holder is spawned, BEFORE readiness. A release-only disposer must not end this lifetime;
// actual exit owns retirement. A failed registration never gives this holder ownership of another holder's entry.
export const namespaceHolderLifetime = (holder: NamespaceHolder, cleanup: () => void) => {
    let ended = false;
    let reference: NamespaceEntryReference | undefined;
    const end = (): void => {
        if (ended) { return; }
        ended = true;
        if (reference !== undefined) { forgetNamespaceEntry(reference); }
        cleanup();
    };
    holder.once("exit", end);
    holder.once("error", end);
    const assertLive = (): void => {
        if (ended || holder.exitCode !== null || holder.signalCode !== null) {
            throw new Error("namespace holder ended during setup");
        }
    };
    return {
        end,
        register: (issue: () => NamespaceEntryReference): NamespaceEntryReference => {
            assertLive();
            if (reference !== undefined) { throw new Error("namespace holder already has an entry"); }
            reference = issue();
            try { assertLive(); } catch (error) {
                forgetNamespaceEntry(reference);
                end();
                throw error;
            }
            return reference;
        },
    };
};

// How long a holder may say nothing before its setup counts as stuck, and how long setup may take in all however steadily
// it reports progress. Both count only time the daemon was awake to read the holder: on 2026-10-13 the daemon's own
// event loop froze for 12 s while a turn's holder was starting, its 10 s deadline passed inside the freeze, and the turn
// failed on a namespace that was most likely ready and waiting in the pipe (the mounts take 0.5 s on an idle sandbox).
export const SETUP_QUIET_MS = 10_000;
export const SETUP_CAP_MS = 60_000;
const SETUP_TICK_MS = 250;

export interface ReadinessOptions {
    readonly quietMs?: number;
    readonly capMs?: number;
    readonly tickMs?: number;
    // The clock the ticks are measured on; a test moves it to stand in for a frozen daemon.
    readonly now?: () => number;
    // What the holder is doing right now, for the failure's sentence (holderActivity reads it from /proc).
    readonly describe?: (pid: number) => string | undefined;
}

// Why setup gave up. `stalled` and `exceeded` are the holder not answering in time, which load explains and a second
// attempt usually clears; `exited` and `refused` are a holder that answered with a failure, which a retry repeats.
export type NamespaceSetupFailure = "stalled" | "exceeded" | "exited" | "refused";

export interface NamespaceSetupFacts {
    // The holder's last progress line (a mount it finished) and how many it reported.
    readonly step?: string | undefined;
    readonly steps: number;
    // Time the daemon was awake for, and time it was frozen and could not have read anything.
    readonly awakeMs: number;
    readonly frozenMs: number;
    readonly activity?: string | undefined;
}

export class NamespaceSetupError extends Error {
    readonly failure: NamespaceSetupFailure;
    readonly facts: NamespaceSetupFacts;
    constructor(failure: NamespaceSetupFailure, message: string, facts: NamespaceSetupFacts) {
        super(message);
        this.name = "NamespaceSetupError";
        this.failure = failure;
        this.facts = facts;
    }
    // A holder that did not answer in time, rather than one that answered with a failure.
    get transient(): boolean {
        return this.failure === "stalled" || this.failure === "exceeded";
    }
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

// The clauses every failure ends with, so a log line says how far setup got, what the holder was doing and whether the
// daemon itself was away for part of the wait.
const factsClause = (facts: NamespaceSetupFacts): string => {
    const clauses = [
        facts.steps > 0 ? `${String(facts.steps)} mount${facts.steps === 1 ? "" : "s"} done, the last ${facts.step ?? "unnamed"}` : "no mount reported done",
        ...(facts.activity === undefined ? [] : [`the holder ${facts.activity}`]),
        ...(facts.frozenMs >= 1_000 ? [`the daemon was frozen for ${seconds(facts.frozenMs)} meanwhile, not counted`] : []),
    ];
    return ` (${clauses.join("; ")})`;
};

const readProc = (path: string): string | undefined => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        // allow(silent-catch): a process that ended between two reads has nothing more to say.
        return undefined;
    }
};

// The holder's deepest live descendant: under a shell that is the mount it is running, not the shell waiting on it.
const leafOf = (pid: number, depth = 0): number => {
    const children = (readProc(`/proc/${String(pid)}/task/${String(pid)}/children`) ?? "").trim().split(/\s+/u).filter(Boolean).map(Number);
    const last = children.at(-1);
    return last === undefined || !Number.isSafeInteger(last) || depth >= 8 ? pid : leafOf(last, depth + 1);
};

/** What a holder is doing right now, read from /proc: its running command, its state and where in the kernel it waits. */
export const holderActivity = (pid: number): string | undefined => {
    const leaf = leafOf(pid);
    const command = (readProc(`/proc/${String(leaf)}/cmdline`) ?? "").split("\0").filter(Boolean).join(" ");
    const stat = readProc(`/proc/${String(leaf)}/stat`);
    if (stat === undefined) {
        return undefined;
    }
    // The state follows the parenthesised command name, which may itself contain spaces and parentheses.
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    const wchan = readProc(`/proc/${String(leaf)}/wchan`)?.trim();
    const waiting = wchan === undefined || wchan === "" || wchan === "0" ? "" : `, waiting in ${wchan}`;
    const shown = command.length > 160 ? `${command.slice(0, 157)}...` : command;
    return `was running ${shown === "" ? `pid ${String(leaf)}` : shown} (state ${state}${waiting})`;
};

// How long a progress line may be before it is discarded whole rather than kept: a mount target is one path.
const LINE_BOUND = 4096;

// Whole lines out of a stream's chunks. Keeps at most a bounded partial line, and discards an oversized one through its
// newline, rather than truncating its prefix into a false marker or dropping a legitimate complete marker before parsing.
const lineReader = (bound: number) => {
    let partial = "";
    let discarding = false;
    return (text: string): string[] => {
        const lines: string[] = [];
        let from = 0;
        for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", from)) {
            if (!discarding) { lines.push(partial + text.slice(from, newline)); }
            partial = "";
            discarding = false;
            from = newline + 1;
        }
        if (!discarding) {
            const tail = text.slice(from);
            discarding = partial.length + tail.length > bound;
            partial = discarding ? "" : partial + tail;
        }
        return lines;
    };
};

// Setup time as the daemon lived it. A tick credits at most two ticks, however late it fires: the rest of the gap is the
// daemon frozen, not the holder slow. `moved` is any sign of life from the holder, which starts its quiet over.
const setupClock = (options: ReadinessOptions) => {
    const quietMs = options.quietMs ?? SETUP_QUIET_MS;
    const capMs = options.capMs ?? SETUP_CAP_MS;
    const tickMs = options.tickMs ?? SETUP_TICK_MS;
    const now = options.now ?? Date.now;
    let last = now();
    const spent = { awakeMs: 0, frozenMs: 0, quietMs: 0 };
    return {
        tickMs,
        capMs,
        spent,
        moved: (): void => { spent.quietMs = 0; },
        tick: (): void => {
            const at = now();
            const gap = Math.max(0, at - last);
            last = at;
            const credited = Math.min(gap, tickMs * 2);
            spent.frozenMs += gap - credited;
            spent.awakeMs += credited;
            spent.quietMs += credited;
        },
        // Which deadline has passed, if one has.
        overdue: (): "stalled" | "exceeded" | undefined => {
            if (spent.quietMs >= quietMs) { return "stalled"; }
            return spent.awakeMs >= capMs ? "exceeded" : undefined;
        },
    };
};

// A fenced anchor reports the pid entrants join on its info fd; one complete record names it, and later noise in the same
// stream cannot erase it.
const pidReporter = () => {
    let reported = "";
    return (text: string): number | undefined => {
        reported += text;
        const match = /"child-pid"\s*:\s*(\d+)\s*[,}]/u.exec(reported);
        reported = reported.slice(-8192);
        return match?.[1] === undefined ? undefined : Number(match[1]);
    };
};

const ended = (holder: NamespaceHolder): boolean => holder.exitCode !== null || holder.signalCode !== null;

// Every holder (mount-only, fenced, agent domain) uses this one bounded handshake. A fenced anchor reports its inner PID
// on info-fd; the mount-only holder keeps its own PID. Neither a partial marker nor an invalid reported PID admits an
// entrant. Any other complete stdout line is a progress report (`mount -v` says one per mount), and any byte on any of
// the holder's streams counts as it still moving.
export const namespaceHolderReady = (
    holder: NamespaceHolder,
    marker: string,
    info?: NamespaceOutput | null,
    options: ReadinessOptions = {},
): Promise<number> => new Promise((resolve, reject) => {
    const { stdout: out, stderr: err } = holder;
    if (ended(holder) || out === null || err === null || info === null) {
        reject(new NamespaceSetupError("refused", "namespace holder is not live with readiness streams", { steps: 0, awakeMs: 0, frozenMs: 0 }));
        return;
    }
    const clock = setupClock(options);
    const describe = options.describe ?? holderActivity;
    const lines = lineReader(Math.max(marker.length, LINE_BOUND));
    const reportedPid = pidReporter();
    let settled = false;
    let stderr = "";
    let pid = info === undefined ? holder.pid : undefined;
    let ready = false;
    let progress: Pick<NamespaceSetupFacts, "steps" | "step"> = { steps: 0 };
    let judging = false;
    const facts = (activity?: string): NamespaceSetupFacts => {
        const known = { ...progress, awakeMs: clock.spent.awakeMs, frozenMs: clock.spent.frozenMs };
        return activity === undefined ? known : { ...known, activity };
    };
    const finish = (error?: Error): void => {
        if (settled) { return; }
        settled = true;
        clearInterval(timer);
        out.off("data", onOutput);
        err.off("data", onStderr);
        info?.off("data", onInfo);
        holder.off("exit", onExit);
        holder.off("error", onError);
        if (error !== undefined) { reject(error); } else { resolve(pid!); }
    };
    const admit = (): void => {
        if (!ready || pid === undefined) { return; }
        if (!Number.isSafeInteger(pid) || pid <= 0) {
            finish(new NamespaceSetupError("refused", "namespace holder reported an invalid PID", facts()));
            return;
        }
        finish();
    };
    const onOutput = (bytes: Buffer): void => {
        clock.moved();
        for (const line of lines(bytes.toString())) {
            const said = line.trim();
            if (line === marker) {
                ready = true;
            } else if (said !== "") {
                progress = { steps: progress.steps + 1, step: said.length > 200 ? `${said.slice(0, 197)}...` : said };
            }
        }
        admit();
    };
    const onStderr = (bytes: Buffer): void => {
        clock.moved();
        stderr = (stderr + bytes.toString()).slice(-8192);
    };
    const onInfo = (bytes: Buffer): void => {
        clock.moved();
        pid ??= reportedPid(bytes.toString());
        admit();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        const said = stderr.trim();
        const how = code === null ? `on ${String(signal)}` : String(code);
        finish(new NamespaceSetupError("exited", `namespace setup exited ${how}${said === "" ? "" : `: ${said}`}${factsClause(facts())}`, facts()));
    };
    const onError = (error: Error): void => { finish(error); };
    // Judged a turn of the loop later, after its poll: a holder whose ready line is already in the pipe is read first.
    const judge = (): void => {
        judging = false;
        const overdue = clock.overdue();
        if (settled || overdue === undefined) { return; }
        const activity = holder.pid === undefined ? undefined : describe(holder.pid);
        const message = overdue === "stalled"
            ? `namespace setup stalled: no progress for ${seconds(clock.spent.quietMs)}${factsClause(facts(activity))}`
            : `namespace setup did not finish within ${seconds(clock.capMs)}${factsClause(facts(activity))}`;
        finish(new NamespaceSetupError(overdue, message, facts(activity)));
    };
    const timer = setInterval(() => {
        clock.tick();
        if (!judging && clock.overdue() !== undefined) {
            judging = true;
            setImmediate(judge);
        }
    }, clock.tickMs);
    out.on("data", onOutput);
    err.on("data", onStderr);
    info?.on("data", onInfo);
    holder.once("exit", onExit);
    holder.once("error", onError);
});

/**
 * Starts a holder, and once more after `delayMs` when the first did not answer in time: load that stalls one setup
 * has usually eased a moment later (2026-10-13: the Continue pressed four seconds after a stalled setup started in 3.5 s).
 * A holder that answered with a failure is not retried; it would answer the same.
 */
export const withSetupRetry = async <T>(
    start: () => Promise<T>,
    options: { readonly delayMs?: number; readonly onRetry?: (error: NamespaceSetupError) => void } = {},
): Promise<T> => {
    try {
        return await start();
    } catch (error) {
        if (!(error instanceof NamespaceSetupError) || !error.transient) { throw error; }
        options.onRetry?.(error);
        await sleep(options.delayMs ?? 1_500);
        return start();
    }
};
