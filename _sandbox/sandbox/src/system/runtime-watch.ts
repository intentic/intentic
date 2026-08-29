import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RuntimeDomain } from "@intentic/sandbox-contract";

const execFileAsync = promisify(execFile);

/* THE PUSH FOR EVERYTHING THAT IS RUNNING RATHER THAN WRITTEN, the fourth change feed, beside the workspace
 * watcher, the repo scan and the ref watch.
 *
 * Those three all start from a file. This one covers the state that has no file at all: tmux sessions, panel
 * dev servers, listening sockets, the agent's browsers, the children its turns spawn. Nothing on disk moves
 * when a dev server binds its port, so no `workspaceChanged` batch could ever say so, and for want of that
 * frame, every view of a running thing carried its own timer. Six of them, in every open tab, forever.
 *
 * The state is in THIS process, so the daemon is the right place to notice. Two halves, because the sources
 * genuinely differ:
 *
 *   ANNOUNCED, the daemon does the thing itself (starts the panel, mints the browser, opens the child), so the
 *   code that changes the state calls `publishRuntimeChange` on its way past. Instant, exact, free.
 *
 *   SAMPLED, nothing tells anyone. A pane dies when its command exits; a dev server binds its port seconds
 *   after launch. Both are only knowable by looking, so the sampler looks. ONCE, here, on the connection the
 *   browsers already hold, instead of once per browser per interval over the tunnel. It runs only while a
 *   browser is subscribed and publishes only when what it sees has changed, so an idle sandbox with a tab open
 *   costs two file reads and one `tmux list-panes` every couple of seconds, and pushes nothing at all.
 *
 * Both halves land in the same throttle, and the throttle is the thing that keeps this cheaper than what it
 * replaces rather than merely faster. */

// How often the sampled half looks. Matches the managed-process sweep, which is the clock a panel's
// start → healthy transition already moves on.
const SAMPLE_MS = 2000;

/* The floor between two frames for one domain, a rate limit, not a debounce: the first change fires
 * immediately and the rest of the burst coalesces into one frame at the end of the window.
 *
 * The numbers are the polls these domains replace, which is the promise being kept: no view refreshes LESS
 * often than it used to, and no domain can ever cost more requests than its poll did. `subagents` is the one
 * that needs the ceiling, a working child reports a tool use and a token count continuously, and without this
 * an unlucky turn would bill every connected browser several roster reads a second to move a number on a card.
 * The discrete domains sit at a quarter-second, which is a burst-coalescing window rather than a real limit:
 * starting a panel touches panels and terminals at once and should arrive as one frame.
 */
const THROTTLE_MS: Record<RuntimeDomain, number> = {
    terminals: 1000,
    panels: 250,
    ports: 250,
    browsers: 1000,
    subagents: 2000,
    // A publish sweep settles a whole batch in a burst of file writes; one frame at the end of it is the whole
    // news. Nothing here changes more often than a post going out.
    drafts: 250,
    // One frame per landing, and a landing is minutes of work, so this window only ever coalesces the burst a
    // multi-repo land makes while writing ONE sentence, which is exactly one frame's worth of news.
    landings: 250,
};

const subscribers = new Set<(domains: RuntimeDomain[]) => void>();

// What has changed and not yet gone out, and the earliest each domain may go out again.
const pending = new Set<RuntimeDomain>();
const nextAllowedAt = new Map<RuntimeDomain, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let timerDueAt = 0;

// Arm the flush for `at`, pulling an already-armed timer EARLIER when a newly-pending domain may go out sooner.
// Without the pull, a frame waiting out a chatty domain's window would drag a discrete one (a panel starting)
// along with it, and a click would feel as slow as the slowest thing in the sandbox.
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

/** Say that a runtime domain moved. Coalesced and rate-limited per domain, so a caller may report every
 *  mutation it makes without weighing what that costs, which is the only way a publish site stays a one-liner
 *  next to the line that did the work.
 *
 *  A publish with nobody connected is DROPPED rather than queued: there is no browser to be stale, and a new
 *  connection re-asks every runtime-bound key anyway (the hello frame, see runtimeBoundQueryKeys). */
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

/* What the sampler compares. A fingerprint, never the answer: knowing that the ports changed costs two file
 * reads, while knowing WHICH process owns each one walks every /proc fd table, far too much to do on a timer,
 * and pure waste when the view that renders it may not even be open. So the cheap half runs on the clock and
 * the expensive half runs when a browser asks. */
export interface RuntimeProbes {
    readonly terminals: () => Promise<string>;
    readonly ports: () => Promise<string>;
}

/* How coarsely a session's activity clock counts as "changed".
 *
 * The terminals list carries each session's last-activity stamp, which the work popover renders as "running ·
 * 2m ago". A session producing output moves that stamp continuously, so an exact fingerprint would push on
 * every sample, a live tail would be the most expensive thing in the sandbox. Bucketing to the interval the
 * old poll ran at keeps that line exactly as fresh as it was, while a session that is merely OPEN moves
 * nothing. Membership, liveness and exit status stay exact: those are what the strip and the badge are. */
const ACTIVITY_BUCKET_MS = 10_000;

// Every session's name, whether its panes are dead, how they exited, and its activity clock, bucketed. One
// exec for the whole tmux server. No server yet means no sessions, which is a fingerprint like any other.
const tmuxFingerprint = async (): Promise<string> => {
    try {
        const { stdout } = await execFileAsync("tmux", [
            "list-panes",
            "-a",
            "-F",
            "#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{session_activity}",
        ]);
        return stdout
            .split("\n")
            .flatMap((line) => {
                const [name, dead, status, activity] = line.split("\t");
                if (name === undefined || name === "") {
                    return [];
                }
                return [`${name}\t${dead ?? ""}\t${status ?? ""}\t${Math.floor((Number(activity) * 1000) / ACTIVITY_BUCKET_MS)}`];
            })
            .toSorted()
            .join("\n");
    } catch {
        return "";
    }
};

// The set of listening TCP ports, straight out of procfs, st 0A is LISTEN, and the port is the second half of
// the local address (hex). Deliberately blind to WHO is listening: the attribution is what costs, and a port
// changing hands without changing number is not something any of these views draw differently.
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

/* The loop, as a factory so a test can drive it with its own probes and clock. Each probe's previous reading is
 * the baseline; a first reading establishes it and publishes nothing, because "different from nothing" is not a
 * change and a browser that just connected has already re-asked.
 *
 * A slow probe never overlaps itself, the tick is skipped rather than queued, so a tmux server wedged for ten
 * seconds costs one late sample instead of five concurrent execs. */
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
            // One reading, two domains: a repo's panel reports healthy when a socket appears under its directory
            // (panels.ts reads health off the listening sockets), so a port arriving IS a panel settling.
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
            // Drop the baselines with the loop: whatever changes while nothing is connected is covered by the
            // wholesale re-ask on the next hello, and a stale baseline would only produce one phantom frame.
            seen.clear();
        },
        sample,
    };
};

const sampler = createRuntimeSampler();

/** Subscribe a /events connection to the runtime feed. The sampled half runs only while at least one connection
 *  holds a subscription, no browser, no looking. */
export const subscribeRuntimeChanges = (listener: (domains: RuntimeDomain[]) => void): (() => void) => {
    subscribers.add(listener);
    sampler.start();
    return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) {
            sampler.stop();
            pending.clear();
            nextAllowedAt.clear();
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
        }
    };
};
