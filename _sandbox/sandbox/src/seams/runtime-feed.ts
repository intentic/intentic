import type { RuntimeDomain } from "@intentic/sandbox-contract";

// The push feed's announcing half, below every subsystem that changes a runtime (a tmux session, a panel, a browser, a
// child turn): each publishes here and the /events stream subscribes (system/runtime-watch.ts), so neither imports the
// other. Coalesced and rate-limited per domain.

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
    // A list's worth of background probes settles within moments of each other; one frame says all of it.
    capabilities: 250,
    runners: 250,
    // One push lands several runs: a commit sets off every workflow a repo has, and they end together.
    ci: 250,
    // Update-all walks engines back to back; each start/end pair folds into one frame.
    engines: 250,
    // A verify fan-out or a turn's start and end log in bursts; each read re-scans the whole log.
    activity: 1000,
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
    // oxlint-disable-next-line unicorn/no-useless-spread -- The spread snapshots pending before deletion.
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

/** Reports a runtime domain moved; coalesced and rate-limited per domain, so a caller can publish on every mutation without weighing the cost. */
export const publishRuntimeChange = (...domains: readonly RuntimeDomain[]): void => {
    if (subscribers.size === 0) {
        return;
    }
    for (const domain of domains) {
        pending.add(domain);
    }
    arm(Date.now());
};

// The last unsubscribe drops what was pending and every rate-limit stamp: with nobody listening nothing is stale, and a
// new connection re-asks every runtime-bound key anyway.
export const onRuntimeChange = (listener: (domains: RuntimeDomain[]) => void): (() => void) => {
    subscribers.add(listener);
    return () => {
        subscribers.delete(listener);
        if (subscribers.size > 0) {
            return;
        }
        pending.clear();
        nextAllowedAt.clear();
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };
};
