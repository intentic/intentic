import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RuntimeDomain } from "@intentic/sandbox-contract";
import { foreground, PANE_FORMAT, paneStates } from "../terminal/pane-state.js";
import { watchPromptSignals } from "../terminal/prompt-signal.js";

const execFileAsync = promisify(execFile);

// Push feed for state with no file on disk: tmux sessions, panel servers, sockets, browsers, child turns.
// - announced: the daemon calls publishRuntimeChange itself when it changes something
// - announced from the shell: zsh hooks report a command starting or finishing via prompt-signal.ts
// - sampled: nothing announces a pane dying or a port opening, so a sampler polls and diffs
// All three land in the same throttle.

// How often the sampled half polls; matches the managed-process sweep panel start→healthy already moves on.
const SAMPLE_MS = 2000;

// Rate limit per domain: the first change fires at once, the rest of a burst coalesces at the window's end.
const THROTTLE_MS: Record<RuntimeDomain, number> = {
    terminals: 1000,
    panels: 250,
    ports: 250,
    browsers: 1000,
    subagents: 2000,
    // An executor pass writes a batch in a burst; one frame at the end of it is the whole news.
    approvals: 250,
    // A landing is minutes of work; this window only coalesces the multi-repo burst writing one sentence.
    landings: 250,
    // A connecting machine fires attach, hello, and describe as three publishes for one arrival; the window folds that
    // burst, and a flapping connection's own reconnect backoff into one frame.
    hosts: 250,
    webext: 250,
    runners: 250,
};

const subscribers = new Set<(domains: RuntimeDomain[]) => void>();

// What has changed and not yet gone out, and the earliest each domain may go out again.
const pending = new Set<RuntimeDomain>();
const nextAllowedAt = new Map<RuntimeDomain, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let timerDueAt = 0;

// Arms the flush for `at`, pulling an already-armed timer earlier if a new domain may go out sooner; otherwise a
// discrete change would wait out a chattier domain's window.
const arm = (at: number): void => {
    if (timer !== undefined) {
        if (timerDueAt <= at) {
            return;
        }
        clearTimeout(timer);
    }
    timerDueAt = at;
    timer = setTimeout(() => void flush(), Math.max(0, at - Date.now()));
    timer.unref();
};

const flush = (): void => {
    timer = undefined;
    const now = Date.now();
    const ready: RuntimeDomain[] = [];
    let soonest: number | undefined;
    // oxlint-disable-next-line unicorn/no-useless-spread -- the loop body deletes from `pending`; the spread is the snapshot that makes iterating-while-removing obviously safe.
    for (const domain of [...pending]) {
        const allowedAt = nextAllowedAt.get(domain) ?? 0;
        if (allowedAt > now) {
            soonest = soonest === undefined ? allowedAt : Math.min(soonest, allowedAt);
            continue;
        }
        pending.delete(domain);
        nextAllowedAt.set(domain, now + THROTTLE_MS[domain]);
        ready.push(domain);
    }
    if (ready.length > 0) {
        for (const listener of subscribers) {
            listener(ready);
        }
    }
    if (soonest !== undefined) {
        arm(soonest);
    }
};

/**
 * Reports a runtime domain moved; coalesced and rate-limited per domain, so a caller can publish on every mutation
 * without weighing the cost. Dropped, not queued, when nobody's connected, since a new connection re-asks everything.
 */
export const publishRuntimeChange = (...domains: readonly RuntimeDomain[]): void => {
    if (subscribers.size === 0) {
        return;
    }
    for (const domain of domains) {
        pending.add(domain);
    }
    arm(Date.now());
};

/* ---- the sampled half ---- */

// A cheap fingerprint, not the answer: knowing a port changed costs two file reads, knowing who owns it walks every
// /proc fd table. The cheap half runs on a timer; the expensive half runs only when a browser asks.
export interface RuntimeProbes {
    readonly terminals: () => Promise<string>;
    readonly ports: () => Promise<string>;
}

// Bucket size for the activity stamp; output alone won't push every sample.
const ACTIVITY_BUCKET_MS = 10_000;

// Terminals list minus tmux-external fields, plus whether a foreground command is running, so a shell prompt alone
// doesn't look unchanged. Busy is a flag, not the command word, so process churn doesn't push every sample.
export const paneFingerprint = (stdout: string): string =>
    [...paneStates(stdout)]
        .map(([name, { live, exitCode, activityAt, liveCommand }]) =>
            [
                name,
                live ? "live" : "dead",
                exitCode ?? "",
                Math.floor(activityAt / ACTIVITY_BUCKET_MS),
                foreground(liveCommand) === undefined ? "" : "busy",
            ].join("\t"),
        )
        .toSorted()
        .join("\n");

// One exec for the whole tmux server. No server yet means no sessions, which is a fingerprint like any other.
const tmuxFingerprint = async (): Promise<string> => {
    try {
        const { stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", PANE_FORMAT]);
        return paneFingerprint(stdout);
    } catch {
        return "";
    }
};

// Listening TCP ports from procfs (st 0A is LISTEN; port is the local address's hex second half). Blind to who holds a
// port, since no view here draws that differently.
const listeningPortsFingerprint = async (procRoot = "/proc"): Promise<string> => {
    const tables = await Promise.all(["tcp", "tcp6"].map((table) => readFile(join(procRoot, "net", table), "utf8").catch(() => "")));
    const ports = new Set<string>();
    for (const table of tables) {
        for (const line of table.split("\n").slice(1)) {
            const fields = line.trim().split(/\s+/);
            const port = fields[1]?.split(":")[1];
            if (fields[3] === "0A" && port !== undefined) {
                ports.add(port);
            }
        }
    }
    return [...ports].toSorted().join(",");
};

const defaultRuntimeProbes: RuntimeProbes = {
    terminals: tmuxFingerprint,
    ports: () => listeningPortsFingerprint(),
};

// Factory so a test can supply its own probes and clock. A first reading only establishes the baseline and publishes
// nothing; a slow probe's tick is skipped rather than queued, never overlapping itself.
export const createRuntimeSampler = (probes: RuntimeProbes = defaultRuntimeProbes, intervalMs = SAMPLE_MS) => {
    const seen = new Map<string, string>();
    let sampling = false;
    let interval: ReturnType<typeof setInterval> | undefined;

    const sample = async (): Promise<void> => {
        if (sampling) {
            return;
        }
        sampling = true;
        try {
            const [terminals, ports] = await Promise.all([probes.terminals(), probes.ports()]);
            const changed = (key: string, value: string): boolean => {
                const had = seen.get(key);
                seen.set(key, value);
                return had !== undefined && had !== value;
            };
            if (changed("terminals", terminals)) {
                publishRuntimeChange("terminals");
            }
            // One reading, two domains: a panel reports healthy off its listening socket, so a port arriving is a panel
            // settling too.
            if (changed("ports", ports)) {
                publishRuntimeChange("ports", "panels");
            }
        } finally {
            sampling = false;
        }
    };

    return {
        start: (): void => {
            if (interval !== undefined) {
                return;
            }
            // Baseline immediately, so the first real change is caught one interval from now rather than two.
            void sample();
            interval = setInterval(() => void sample(), intervalMs);
            interval.unref();
        },
        stop: (): void => {
            if (interval !== undefined) {
                clearInterval(interval);
                interval = undefined;
            }
            // Dropped with the loop: changes while nothing's connected are covered by the next hello's re-ask; a stale
            // baseline would produce a phantom frame.
            seen.clear();
        },
        sample,
    };
};

const sampler = createRuntimeSampler();

// zsh hooks report a command's start and prompt-return, the one transition tmux itself doesn't expose; held for as long
// as anything is subscribed.
let unwatchPrompts: (() => void) | undefined;

/**
 * Subscribes a /events connection to the runtime feed. The sampled half runs only while at least one subscriber holds
 * it: no browser, no looking.
 */
export const subscribeRuntimeChanges = (listener: (domains: RuntimeDomain[]) => void): (() => void) => {
    subscribers.add(listener);
    sampler.start();
    unwatchPrompts ??= watchPromptSignals(() => publishRuntimeChange("terminals"));
    return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) {
            sampler.stop();
            unwatchPrompts?.();
            unwatchPrompts = undefined;
            pending.clear();
            nextAllowedAt.clear();
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
        }
    };
};
