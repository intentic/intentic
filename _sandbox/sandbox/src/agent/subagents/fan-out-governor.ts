import { dropClaim, resetBudgetPlanner } from "../run/spend/budget-planner.js";

/* THE FAN-OUT GOVERNOR: how many children go onto one provider at once, decided at spawn.

   2026-10-17: a parent started seven children in a minute across five providers. Three went onto Cursor, which nothing
   had proven that day: the first was refused for a spent plan, the next two for an account Cursor refuses outright, and
   the parent heard of the first refusal only after all seven were out. Three Codex children at high effort emptied a
   team credit in about 25 minutes. Every one of those refusals was knowable from the first.

   Two rules, the first per provider and model as the records file refusals, the second per provider's accounts:
   - A provider and model no turn was answered on lately (a child's, the parent's own, any other) gets one child first,
     the canary. Its siblings wait as pending
     until it is answered (the provider took the turn: start them) or refused before answering (re-check each against
     the records, which now hold the refusal: one still askable becomes the next canary, one the records call spent is
     handed back unstarted, having spent nothing). A canary slow to answer (waiting for memory, a long first thought)
     does not hold its siblings for good: past CANARY_PATIENCE_MS they all go.
   - A child goes only where an account can carry it through its windows, and is placed on that account: the fan-out
     planner's claim (agent/run/spend/budget-planner.ts), which each held start makes for itself as it is released, answering
     `wait` when the accounts still cannot carry it. The lane then waits too, until a sibling ends, any turn on the
     provider ends, a reading lands (`reconsider`) or the window that decided it reopens (`retryAt`). This replaced a cap
     that read only a percentage below 30% left, and so let ten Opus children onto one account reading 84% (2026-10-20).
   And the spawn result says what siblings on the provider just ran into, so a parent reading it learns of a refusal it
   would otherwise hear of only after its whole fan-out is out.

   State is the daemon's own and in memory: a restart forgets which providers were proven, and the next fan-out probes
   again, which costs one child's wait. */

// How long one answered child proves a provider and model: past this, conditions may have changed (a window ran out, an
// account was switched off), and the next fan-out probes again.
export const PROVEN_FOR_MS = 30 * 60_000;

// How long a canary may take to be answered before its siblings go anyway.
export const CANARY_PATIENCE_MS = 3 * 60_000;

// How long a lane that waited on the budget with no reopening named waits before it asks again by itself; a sibling
// ending, a turn ending or a reading landing asks sooner.
const BUDGET_RECHECK_MS = 5 * 60_000;

// How far back a sibling's refusal is worth telling a parent about as it spawns.
const SIBLING_NEWS_MS = 10 * 60_000;

// What a child is placed on, as the refusal records key it.
export interface Lane {
    readonly provider: string;
    readonly model: string;
}

/** A held start the budget still cannot carry: it goes back to the head of its lane, asked again by `retryAt` at the latest. */
export interface HeldWait {
    readonly wait: true;
    // Epoch ms the window that held it reopens, where one did.
    readonly retryAt?: number | undefined;
}

/** A start held by the governor: what it starts, and what it does when the records say it should not after all. */
export interface HeldStart {
    readonly childId: string;
    readonly lane: Lane;
    // Starts the child now; asks the records first (the caller's own preflight) and hands the child back unstarted when
    // they call its model spent, or answers that it waits on the budget still. Answers whether it started otherwise.
    readonly start: () => Promise<boolean | HeldWait>;
    // Hands the child back unstarted, with the reason its parent reads.
    readonly abandon: (why: string) => Promise<void>;
    // Gives back what the held start keeps while it waits (its parent's seat), for a start its parent cancelled.
    readonly cancel: () => void;
}

export type Admission = { readonly go: true } | { readonly go: false; readonly reason: string };

/** One sibling's recent ending that its next sibling's spawn should mention. */
export interface SiblingNews {
    readonly childId: string;
    readonly lane: Lane;
    readonly at: number;
    readonly failure: string;
}

interface LaneState {
    // When a child on it was last answered.
    provenAt: number | undefined;
    // The child that went first and has not been answered yet, and when it started.
    canary: { readonly childId: string; readonly at: number } | undefined;
    // Its patience timer, which releases the held ones if the canary takes too long.
    patience: ReturnType<typeof setTimeout> | undefined;
    // Starts waiting on this lane, oldest first.
    readonly held: HeldStart[];
    // When the lane asks the budget again by itself, having waited on it.
    retry: { readonly at: number; readonly timer: ReturnType<typeof setTimeout> } | undefined;
}

const keyOf = (lane: Lane): string => `${lane.provider}/${lane.model}`;

export interface FanOutGovernor {
    // Whether a child on this lane may start now as far as its lane is proven. A child that may go is counted as running
    // on the provider from here, and becomes the lane's canary where it needs one; the budget is asked after (children.ts).
    readonly admit: (childId: string, lane: Lane) => Admission;
    // An admitted child the budget then held: no longer counted as running, nor its lane's canary.
    readonly retract: (childId: string) => void;
    // How many children count as running on the provider: none, and a child goes whatever the budget projects.
    readonly runningOn: (provider: string) => number;
    // Something that may have freed room on the provider (a turn ended, a reading landed): its waiting starts are asked again.
    readonly reconsider: (provider: string) => void;
    // Counts an already running turn restored at boot before releasing any held starts.
    readonly adopt: (childId: string, lane: Lane) => void;
    // Queues a start the admission held back; its lane asks again by itself before long, as well as on every release.
    readonly hold: (held: HeldStart) => void;
    // Takes a held start back off its lane (a cancel), giving back what it kept; answers whether it was held.
    readonly withdraw: (childId: string) => boolean;
    // The child was answered: its lane is proven, and what waited on it goes.
    readonly answered: (childId: string) => void;
    // Any turn on this provider and model was answered (a parent's own, a sibling's helper job): proof enough that a
    // child placed on it will be served too.
    readonly served: (lane: Lane) => void;
    // The child's turn ended, answered or not; a failure is news for its siblings.
    readonly ended: (childId: string, ending: { readonly answered: boolean; readonly failure: string | undefined }) => void;
    // What siblings on this provider just ran into, newest first.
    readonly news: (provider: string) => readonly SiblingNews[];
    // Every lane, every count and every timer dropped: a suite's clean slate.
    readonly reset: () => void;
}

// Everything one governor holds: each lane's standing, the children counted on each provider, and the refusals its
// siblings ran into.
interface Governor {
    readonly now: () => number;
    readonly lanes: Map<string, LaneState>;
    // The children counted as running, and the lane each is on.
    readonly running: Map<string, Lane>;
    readonly recent: SiblingNews[];
}

const stateOf = (governor: Governor, lane: Lane): LaneState => {
    const key = keyOf(lane);
    let state = governor.lanes.get(key);
    if (state === undefined) {
        state = { provenAt: undefined, canary: undefined, patience: undefined, held: [], retry: undefined };
        governor.lanes.set(key, state);
    }
    return state;
};

const runningOn = (governor: Governor, provider: string): number =>
    [...governor.running.values()].filter((lane) => lane.provider === provider).length;

const proven = (governor: Governor, state: LaneState): boolean => state.provenAt !== undefined && governor.now() - state.provenAt < PROVEN_FOR_MS;

const decide = (governor: Governor, childId: string, lane: Lane): Admission => {
    const state = stateOf(governor, lane);
    if (!proven(governor, state) && state.canary !== undefined && state.canary.childId !== childId) {
        return {
            go: false,
            reason: `it waits for \`${state.canary.childId}\`, the first child on ${keyOf(lane)} since nothing answered on it lately, to be answered: a provider nothing has proven is tried with one child before the rest, so a refusal costs one start instead of all of them`,
        };
    }
    return { go: true };
};

// The lane stops waiting on its canary: answered, ended, or past its patience.
const dropCanary = (state: LaneState): void => {
    clearTimeout(state.patience);
    state.canary = undefined;
    state.patience = undefined;
};

// Counted as running from here; the first child on a lane nothing has proven becomes its canary, with its patience.
const go = (governor: Governor, childId: string, lane: Lane): void => {
    governor.running.set(childId, lane);
    const state = stateOf(governor, lane);
    if (proven(governor, state) || state.canary !== undefined) {
        return;
    }
    state.canary = { childId, at: governor.now() };
    state.patience = setTimeout(() => {
        if (state.canary?.childId === childId) {
            // Slow, not refused: the siblings go, and the lane counts as proven until a start on it is refused.
            state.canary = undefined;
            state.provenAt = governor.now();
            release(governor, state);
        }
    }, CANARY_PATIENCE_MS);
    state.patience.unref();
};

// A child no longer counted, and its lane's canary dropped if it was one.
const forget = (governor: Governor, childId: string): Lane | undefined => {
    const lane = governor.running.get(childId);
    governor.running.delete(childId);
    if (lane !== undefined && stateOf(governor, lane).canary?.childId === childId) {
        dropCanary(stateOf(governor, lane));
    }
    return lane;
};

// The lane asks again by itself at `at`, or sooner where it already meant to.
const retryLater = (governor: Governor, state: LaneState, at: number): void => {
    if (state.retry !== undefined && state.retry.at <= at) {
        return;
    }
    clearTimeout(state.retry?.timer);
    const timer = setTimeout(
        () => {
            state.retry = undefined;
            release(governor, state);
        },
        Math.max(0, at - governor.now()),
    );
    timer.unref();
    state.retry = { at, timer };
};

// Lanes being released right now: one pass at a time each, so two seats freeing together start two waiters rather than
// asking the budget for the same one twice. A release asked for during a pass runs once more after it, since what freed
// room may have come after the pass's budget answer.
const releasing = new WeakSet<LaneState>();
const askedAgain = new WeakSet<LaneState>();

// Starts what waits on a lane, oldest first, as far as the rules let; a start the records refuse is handed back by the
// start itself, and the next one is tried. One the budget still holds goes back to the head, and the lane waits with it.
const release = (governor: Governor, state: LaneState): void => {
    if (releasing.has(state)) {
        askedAgain.add(state);
        return;
    }
    releasing.add(state);
    void (async () => {
        try {
            for (let next = state.held[0]; next !== undefined && decide(governor, next.childId, next.lane).go; next = state.held[0]) {
                state.held.shift();
                go(governor, next.childId, next.lane);
                const outcome = await next.start();
                if (outcome === true) {
                    continue;
                }
                // Handed back unstarted, or still waiting on the budget: it was never running.
                forget(governor, next.childId);
                if (outcome !== false) {
                    state.held.unshift(next);
                    retryLater(governor, state, outcome.retryAt ?? governor.now() + BUDGET_RECHECK_MS);
                    return;
                }
            }
        } finally {
            releasing.delete(state);
            if (askedAgain.delete(state)) {
                release(governor, state);
            }
        }
    })();
};

const reconsider = (governor: Governor, provider: string): void => {
    for (const state of governor.lanes.values()) {
        if (state.held.some((held) => held.lane.provider === provider)) {
            release(governor, state);
        }
    }
};

const withdraw = (governor: Governor, childId: string): boolean => {
    for (const state of governor.lanes.values()) {
        const index = state.held.findIndex((held) => held.childId === childId);
        if (index !== -1) {
            const [held] = state.held.splice(index, 1);
            held?.cancel();
            return true;
        }
    }
    return false;
};

const served = (governor: Governor, lane: Lane): void => {
    const state = stateOf(governor, lane);
    state.provenAt = governor.now();
    if (state.canary === undefined) {
        release(governor, state);
    }
};

const ended = (governor: Governor, childId: string, ending: { readonly answered: boolean; readonly failure: string | undefined }): void => {
    // Whatever placed it on an account counts it there no more: it ran, or never will (budget-planner.ts).
    dropClaim(childId);
    const lane = forget(governor, childId);
    if (lane === undefined) {
        return;
    }
    if (ending.failure !== undefined && !ending.answered) {
        governor.recent.unshift({ childId, lane, at: governor.now(), failure: ending.failure });
        governor.recent.splice(20);
        // Refused before it answered: whatever proved the lane (an answer, a canary's patience running out) no longer
        // does, and the next start on it goes first again.
        stateOf(governor, lane).provenAt = undefined;
    }
    // A seat freed on the provider may let a start the budget held go, whatever lane it is on.
    reconsider(governor, lane.provider);
};

export const createFanOutGovernor = (now: () => number = Date.now): FanOutGovernor => {
    const governor: Governor = { now, lanes: new Map(), running: new Map(), recent: [] };
    return {
        admit: (childId, lane) => {
            const verdict = decide(governor, childId, lane);
            if (verdict.go) {
                go(governor, childId, lane);
            }
            return verdict;
        },
        retract: (childId) => void forget(governor, childId),
        runningOn: (provider) => runningOn(governor, provider),
        reconsider: (provider) => reconsider(governor, provider),
        adopt: (childId, lane) => go(governor, childId, lane),
        hold: (held) => {
            const state = stateOf(governor, held.lane);
            state.held.push(held);
            // A start the budget held hears of nothing that frees room on its own (a window reopening); a canary-held one
            // asks again for nothing, its lane still unproven.
            retryLater(governor, state, now() + BUDGET_RECHECK_MS);
        },
        withdraw: (childId) => withdraw(governor, childId),
        answered: (childId) => {
            const lane = governor.running.get(childId);
            if (lane === undefined) {
                return;
            }
            const state = stateOf(governor, lane);
            state.provenAt = now();
            if (state.canary?.childId === childId) {
                dropCanary(state);
            }
            release(governor, state);
        },
        served: (lane) => served(governor, lane),
        ended: (childId, ending) => ended(governor, childId, ending),
        news: (provider) => governor.recent.filter((entry) => entry.lane.provider === provider && now() - entry.at < SIBLING_NEWS_MS),
        reset: () => {
            resetBudgetPlanner();
            for (const state of governor.lanes.values()) {
                clearTimeout(state.patience);
                clearTimeout(state.retry?.timer);
            }
            governor.lanes.clear();
            governor.running.clear();
            governor.recent.splice(0);
        },
    };
};

// How much of a sibling's refusal a spawn result quotes.
const NEWS_CHARS = 160;

/** What a spawn result says of siblings on the same provider that were just refused; undefined for none. */
export const siblingNewsWords = (news: readonly SiblingNews[], now: number = Date.now()): string | undefined => {
    if (news.length === 0) {
        return undefined;
    }
    const lines = news.slice(0, 3).map((entry) => {
        const ago = Math.max(1, Math.round((now - entry.at) / 60_000));
        const said = entry.failure.replaceAll(/\s+/gu, " ").trim();
        return `\`${entry.childId}\` on ${keyOf(entry.lane)}, ${String(ago)} min ago: "${said.length > NEWS_CHARS ? `${said.slice(0, NEWS_CHARS)}…` : said}"`;
    });
    const more = news.length > 3 ? ` and ${String(news.length - 3)} more` : ``;
    return `Siblings on this provider were refused before they did any work just now: ${lines.join("; ")}${more}. Weigh that before starting more on it.`;
};

/** The daemon's one governor: every parent's children share the providers they spend. */
export const FAN_OUT = createFanOutGovernor();
