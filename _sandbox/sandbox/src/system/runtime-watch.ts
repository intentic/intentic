import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeDomain } from "@intentic/sandbox-contract";
import { forkedExec } from "@intentic/scaffold";
import { onRuntimeChange, publishRuntimeChange } from "../seams/runtime-feed.js";
import { foreground, PANE_FORMAT, paneStates } from "../terminal/pane-state.js";
import { watchPromptSignals } from "../terminal/prompt-signal.js";

// Push feed for state with no file on disk: tmux sessions, panel servers, sockets, browsers, child turns.
// - announced: the daemon calls publishRuntimeChange itself when it changes something (seams/runtime-feed.ts)
// - announced from the shell: zsh hooks report a command starting or finishing via prompt-signal.ts
// - sampled: nothing announces a pane dying or a port opening, so a sampler polls and diffs
// All three land in the same throttle.

// How often the sampled half polls; matches the managed-process sweep panel start→healthy already moves on.
const SAMPLE_MS = 2000;

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
        const { stdout } = await forkedExec("tmux", ["list-panes", "-a", "-F", PANE_FORMAT]);
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
// The /events connections subscribed here; the sampler runs while there is one.
let listeners = 0;

/** Subscribes a /events connection to the runtime feed. */
export const subscribeRuntimeChanges = (listener: (domains: RuntimeDomain[]) => void): (() => void) => {
    const unsubscribe = onRuntimeChange(listener);
    listeners += 1;
    sampler.start();
    unwatchPrompts ??= watchPromptSignals(() => publishRuntimeChange("terminals"));
    return () => {
        unsubscribe();
        listeners -= 1;
        if (listeners === 0) {
            sampler.stop();
            unwatchPrompts?.();
            unwatchPrompts = undefined;
        }
    };
};
