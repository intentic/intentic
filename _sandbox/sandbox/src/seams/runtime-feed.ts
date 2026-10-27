import type { RuntimeDomain } from "@intentic/sandbox-contract/state/runtime-state";
import type { Logger } from "pino";

// The push feed's announcing half, below every subsystem that changes a runtime (a tmux session, a panel, a browser, a
// child turn): each publishes here and the /events stream subscribes (system/runtime-watch.ts), so neither imports the
// other. Coalesced and rate-limited per domain.

// Rate limit per domain: the first change fires at once, the rest of a burst coalesces at the window's end.
const THROTTLE_MS: Record<RuntimeDomain, number> = {
    terminals: 1000,
    panels: 250,
    ports: 250,
    browsers: 1000,
    // A window opening or closing is one change, and a program that opens three at once is still one piece of news.
    desktop: 250,
    // Every SDK task_progress tick (a token count, a tool use) patches a child and publishes here, and each frame makes
    // every open board re-read the roster; a second folds that chatter. A child being born or ending is not chatter: it
    // goes out at once through publishRuntimeMilestone (2026-10-20, down from 2000 so a transcript pane refetching on
    // this domain sees a running child's progress within a second).
    subagents: 1000,
    // An executor pass writes a batch in a burst; one frame at the end of it is the whole news.
    approvals: 250,
    // A landing is minutes of work; this window only coalesces the multi-repo burst writing one sentence.
    landings: 250,
    // A connecting machine fires attach, hello, and describe as three publishes for one arrival; the window folds that
    // burst, and a flapping connection's own reconnect backoff into one frame.
    hosts: 250,
    webext: 250,
    phones: 250,
    // A list's worth of background probes settles within moments of each other; one frame says all of it.
    capabilities: 250,
    runners: 250,
    // One push lands several runs: a commit sets off every workflow a repo has, and they end together.
    ci: 250,
    // Update-all walks engines back to back; each start/end pair folds into one frame.
    engines: 250,
    // A turn's start and end log in bursts; each read re-scans the whole log.
    activity: 1000,
    // What an automatic update waits on moves with every turn's start and end; a page needs the gist, not each beat.
    update: 1000,
    // A yes is one click, but a purge forgets a conversation's grants and releases in the same moment.
    grants: 250,
    // A draft is written every few hundred milliseconds while somebody types; each frame makes their windows read it back.
    // Published to its writer alone (publishRuntimeChangeTo): the list a window reads back is its own person's.
    drafts: 250,
    // A person asking, or the owner answering, is one press; a grant that answers several at once still reads as one.
    "access-requests": 250,
};

/**
 * Who a flushed domain's change is for, by the actor a request is authorized as (auth/principal.ts `actorOf`); a domain
 * absent here is everyone's news.
 */
export type RuntimeAudiences = ReadonlyMap<RuntimeDomain, ReadonlySet<string>>;

type RuntimeListener = (domains: RuntimeDomain[], audiences: RuntimeAudiences) => void;

// Each subscriber, with where its own failure is reported: the /events connection's logger, or none.
const subscribers = new Map<RuntimeListener, Pick<Logger, "warn"> | undefined>();

// The windows are measured on the monotonic clock the timers themselves run on. Stamped with the wall clock, a step
// back (an NTP or WSL resync) left every window apparently still open, and the flush re-armed itself until the wall
// clock caught up: a milestone was held for the whole step (CI, 2026-10-26). Fake timers move this clock too.
const now = (): number => performance.now();

// What has changed and not yet gone out, and the earliest each domain may go out again.
const pending = new Set<RuntimeDomain>();
// For a pending domain only some people's windows need: whose. A domain published for everyone in the same window is
// everyone's, whatever was published to a person in it.
const pendingAudiences = new Map<RuntimeDomain, Set<string> | "everyone">();
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
    timer = setTimeout(() => void flush(), Math.max(0, at - now()));
    timer.unref();
};

const flush = (): void => {
    timer = undefined;
    const flushedAt = now();
    const ready: RuntimeDomain[] = [];
    const audiences = new Map<RuntimeDomain, ReadonlySet<string>>();
    let soonest: number | undefined;
    // oxlint-disable-next-line unicorn/no-useless-spread -- The spread snapshots pending before deletion.
    for (const domain of [...pending]) {
        const allowedAt = nextAllowedAt.get(domain) ?? 0;
        if (allowedAt > flushedAt) {
            soonest = soonest === undefined ? allowedAt : Math.min(soonest, allowedAt);
            continue;
        }
        pending.delete(domain);
        nextAllowedAt.set(domain, flushedAt + THROTTLE_MS[domain]);
        ready.push(domain);
        const audience = pendingAudiences.get(domain);
        pendingAudiences.delete(domain);
        if (audience !== undefined && audience !== "everyone") {
            audiences.set(domain, audience);
        }
    }
    // Re-armed before the listeners run, and each listener isolated, as domain-events isolates its own: one that
    // throws must neither starve the listeners after it nor strand the domains still waiting for their window. A
    // subscriber with no logger of its own has its failure raised once everyone has heard, as an uncaught one always was.
    if (soonest !== undefined) {
        arm(soonest);
    }
    let unreported: { readonly error: unknown } | undefined;
    for (const [listener, failed] of ready.length > 0 ? subscribers : []) {
        try {
            listener(ready, audiences);
        } catch (error) {
            if (failed === undefined) {
                unreported ??= { error };
            } else {
                failed.warn({ err: error, domains: ready }, "runtime feed: a subscriber failed on a change; the others still heard it");
            }
        }
    }
    if (unreported !== undefined) {
        throw unreported.error;
    }
};

// How many times each domain has been published, counted at the change rather than at the throttled flush, and whether
// or not anyone listens: a read shared between the windows a frame sends to re-read (the terminals listing) is keyed by
// it, so it is stale from the moment a change is announced, before any frame goes out.
const generations = new Map<RuntimeDomain, number>();

/** The number of changes announced for `domain` so far in this process. */
export const runtimeGeneration = (domain: RuntimeDomain): number => generations.get(domain) ?? 0;

/** Reports a runtime domain moved; coalesced and rate-limited per domain, so a caller can publish on every mutation without weighing the cost. */
export const publishRuntimeChange = (...domains: readonly RuntimeDomain[]): void => {
    for (const domain of domains) {
        generations.set(domain, runtimeGeneration(domain) + 1);
    }
    if (subscribers.size === 0) {
        return;
    }
    for (const domain of domains) {
        pending.add(domain);
        pendingAudiences.set(domain, "everyone");
    }
    arm(now());
};

/**
 * Reports a domain moved for one person's windows only, `actor` as auth/principal.ts names a caller: their composer
 * drafts, which nobody else's windows read. Throttled in the domain's one window like any change; a burst from several
 * people goes out as one frame to each of them.
 */
export const publishRuntimeChangeTo = (actor: string, domain: RuntimeDomain): void => {
    generations.set(domain, runtimeGeneration(domain) + 1);
    if (subscribers.size === 0) {
        return;
    }
    const audience = pendingAudiences.get(domain);
    if (audience === undefined) {
        pendingAudiences.set(domain, new Set([actor]));
    } else if (audience !== "everyone") {
        audience.add(actor);
    }
    pending.add(domain);
    arm(now());
};

// The shortest gap a milestone keeps after the frame before it, so a fleet of children ending together still folds.
const MILESTONE_MS = 250;

/**
 * Reports a move a reader is waiting on (a child ending, one being born), which goes out within MILESTONE_MS even inside
 * the domain's window: the window is there to fold chatter, not to hold back the change the chatter led up to
 * (2026-10-20). The full window restarts from the frame it goes out in.
 */
export const publishRuntimeMilestone = (...domains: readonly RuntimeDomain[]): void => {
    for (const domain of domains) {
        const allowedAt = nextAllowedAt.get(domain);
        if (allowedAt !== undefined) {
            nextAllowedAt.set(domain, Math.min(allowedAt, allowedAt - THROTTLE_MS[domain] + MILESTONE_MS));
        }
    }
    publishRuntimeChange(...domains);
};

// The last unsubscribe drops what was pending and every rate-limit stamp: with nobody listening nothing is stale, and a
// new connection re-asks every runtime-bound key anyway.
export const onRuntimeChange = (listener: RuntimeListener, failed?: Pick<Logger, "warn">): (() => void) => {
    subscribers.set(listener, failed);
    return () => {
        subscribers.delete(listener);
        if (subscribers.size > 0) {
            return;
        }
        pending.clear();
        pendingAudiences.clear();
        nextAllowedAt.clear();
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };
};
