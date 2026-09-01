import type { SandboxSummary } from "@intentic-app/api-contract";
import type { AgentSummary, AutomationApproval } from "@intentic/sandbox-contract";
import { computed, shallowRef, watch } from "vue";
import { blocked, turnInFlight } from "../agents/agentStatus";
import { onScreen } from "../onScreen";
import { queryClient } from "../queryPersistence";
import { AGENTS } from "../queryKeys";
import { sandboxJsonQuietly } from "./sandboxClient";
import { connectedSandboxes } from "./roster";
import { useSandbox } from "./useSandbox";

/* WHAT EVERY OTHER SANDBOX IS DOING, for the surfaces that read across them (the fleet board's All-sandboxes
 * scope, and the changes ledger behind it). The active sandbox is deliberately absent from this store: it has
 * a live `/events` stream and `useAgents` is its authority, so including it here would be a second, slower
 * account of the box the user is standing in, arriving late and disagreeing.
 *
 * PULL, NOT STREAM, AND THAT IS THE WHOLE COST MODEL. The daemon's event stream is written for one connection
 * per browser: its watchdog, its backoff, its presence routing and its registry-revision epoch all assume a
 * single line whose failures mean something about the workspace on screen. Opening one per sandbox would
 * multiply every one of those, spend a socket from the origin's pool for each (which the transport already has
 * to ration, see streamBudget), and deliver frames about work nobody is watching. A read every
 * `POLL_MS` costs one request per sandbox and answers the only question this store is asked.
 *
 * IT NEVER WAKES A MACHINE. A hosted sandbox stops itself when nobody is around, and the wake reflex in
 * useSandbox fires for the ACTIVE sandbox alone, on purpose. A poll that woke every box the account owns would
 * turn opening a board into a bill, and would defeat idle-stop entirely for anyone with the scope switched on.
 * So a box that does not answer is reported as not answering, its last-known counts are kept, and waking it is
 * a press the user makes (which selects it, at which point it stops being this module's business).
 *
 * IT RUNS ONLY WHILE SOMETHING IS WATCHING. `subscribe()` is what starts the loop and its disposer is what
 * stops it, so a board on another route, or a window in the background, costs nothing at all.
 *
 * IT NEVER ASKS THE READER FOR ANYTHING, which is why every call it makes goes through `sandboxJsonQuietly`.
 * Reaching a box this browser holds no session for otherwise starts a Google sign-in, and that sign-in is
 * window-wide UI raised on behalf of a machine nobody is looking at — worse, an unreachable box stores nothing,
 * so it asked again on the next tick and the next page load. A quiet read spends the credential already in hand
 * and takes no for an answer, which lands in the same place a dead tunnel does: `unreachable`. */

// How often each sandbox is re-read while a surface is subscribed and the window is on screen. Slow on
// purpose: this is ambient awareness of work happening elsewhere, not a live feed, and the sandbox the user is
// actually in is streamed. Fast enough that an agent finishing in another box is noticed within a minute.
const POLL_MS = 45_000;

// A read older than this is worth redoing when a surface subscribes or the window comes back. Below it, the
// stored answer is served as-is, so flipping the scope control twice does not cost two rounds of requests.
const FRESH_MS = 20_000;

/* WHERE ONE OTHER SANDBOX STANDS, as the three answers a card or a row can honestly draw.
 *
 * `reading` only ever means "has never answered and a read is in flight". A box that HAS answered keeps
 * `ready` across a refresh, since redrawing a populated column as a spinner every 45 seconds is the flicker
 * this store exists to avoid.
 *
 * `unreachable` keeps whatever it last held rather than emptying. The agents did not stop existing because
 * the tunnel blinked, and a surface that zeroes a count on a failed read is making the claim this design
 * refuses (see `unknown` in the surfaces: never `0`). */
export type BoxState = "reading" | "ready" | "unreachable";

export interface BoxFleet {
    readonly sandbox: SandboxSummary;
    readonly state: BoxState;
    readonly agents: readonly AgentSummary[];
    readonly held: readonly AutomationApproval[];
    // When this box last answered, ever. Undefined means nothing here has been true yet, which is the one
    // case a surface must not render as a number.
    readonly readAt: number | undefined;
}

const boxes = shallowRef<Record<string, BoxFleet>>({});

const { sandboxes, activeSandboxId } = useSandbox();

// The sandboxes this store reads: ones that have checked in at least once (an unfinished sandbox has no
// daemon to ask, see roster.ts) and are not the one being streamed.
const targets = computed<readonly SandboxSummary[]>(() =>
    connectedSandboxes(sandboxes.value).filter((sandbox) => sandbox.id !== activeSandboxId.value),
);

const write = (id: string, patch: Partial<BoxFleet> & { readonly sandbox: SandboxSummary }): void => {
    const previous = boxes.value[id];
    boxes.value = {
        ...boxes.value,
        [id]: {
            agents: previous?.agents ?? [],
            held: previous?.held ?? [],
            readAt: previous?.readAt,
            state: previous?.state ?? `reading`,
            ...patch,
        },
    };
};

// One read per sandbox at a time. A poll tick that lands while the previous one is still out (a slow tunnel,
// a sandbox under load) must not stack a second request behind it.
const inFlight = new Set<string>();

// Is a read worth issuing right now? `force` is a caller's own "check now" and skips the freshness window,
// never the in-flight guard: two overlapping requests for one box answer the same question twice.
const dueFor = (sandbox: SandboxSummary, force: boolean): boolean => {
    if (inFlight.has(sandbox.id)) {
        return false;
    }
    const readAt = boxes.value[sandbox.id]?.readAt;
    return force || readAt === undefined || Date.now() - readAt >= FRESH_MS;
};

// What a box wears WHILE a read of it is out. Only a box that has never answered shows as reading; every
// other one keeps what it was, so a poll does not blink a populated column back into a spinner.
const readingState = (held: BoxFleet | undefined): BoxState => (held === undefined || held.readAt === undefined ? `reading` : held.state);

const readBox = async (sandbox: SandboxSummary, force: boolean): Promise<void> => {
    if (!dueFor(sandbox, force)) {
        return;
    }
    inFlight.add(sandbox.id);
    write(sandbox.id, { sandbox, state: readingState(boxes.value[sandbox.id]) });
    try {
        const body = await sandboxJsonQuietly<{ agents: AgentSummary[]; rev: number; held?: AutomationApproval[] }>(sandbox.id, `/agents`);
        write(sandbox.id, { sandbox, state: `ready`, agents: body.agents, held: body.held ?? [], readAt: Date.now() });
        /* Filed in the shared cache under this sandbox's own key as well as in the store above. Nothing reads
         * it from there yet; what it buys is that these entries are swept by exactly the machinery that sweeps
         * every other per-sandbox entry, `sandboxQueryPredicate` finds them by the id in the last position, so
         * a workspace replaced under one of these boxes drops this browser's account of its fleet with
         * everything else it remembered about it. A store that quietly opted out of that would be the one
         * surface still painting a workspace that no longer exists. */
        queryClient.setQueryData(AGENTS.ofSandbox(sandbox.id), body.agents);
    } catch {
        /* Every failure is one answer, because there is one useful thing to say. A sleeping hosted machine, a
         * tunnel that is down, a laptop that is closed and a sandbox mid-rebuild are indistinguishable from
         * here and identical in what they mean to a reader: this box is not answering, what you last saw is
         * what there is. Telling them apart would take a platform round trip per box per poll, to change a
         * sentence nobody acts on differently. */
        write(sandbox.id, { sandbox, state: `unreachable` });
    } finally {
        inFlight.delete(sandbox.id);
    }
};

const readAll = (force: boolean): void => {
    for (const sandbox of targets.value) {
        void readBox(sandbox, force);
    }
};

// How many surfaces want this store live. The loop runs while at least one does AND the window is on screen:
// a background tab polling every sandbox the account owns is the same bill as the wake reflex this module
// refuses to fire, arriving more slowly.
let watchers = 0;
let timer: ReturnType<typeof setInterval> | undefined;

const stopLoop = (): void => {
    if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
    }
};

const syncLoop = (): void => {
    const wanted = watchers > 0 && onScreen.value;
    if (!wanted) {
        stopLoop();
        return;
    }
    if (timer === undefined) {
        timer = setInterval(() => readAll(false), POLL_MS);
    }
};

/* THE WATCHERS ARE PART OF THE SUBSCRIPTION, not of the module.
 *
 * Registered at module scope they would run on IMPORT, and `watch` evaluates its source to take a first
 * reading, so merely importing this file, which the switcher does, and the switcher is on every screen, would
 * pull the sandbox list into existence before anything had asked for it. That is the wrong cost and the wrong
 * order: this store's whole claim is that it does nothing at all until a surface subscribes.
 *
 * Torn down with the last subscriber, so an app that flips the scope off goes back to importing an inert
 * module rather than one holding two live effects over a list it is not reading. */
let watching: (() => void)[] = [];

const startWatching = (): void => {
    watching = [
        // A window coming back to the front reads immediately rather than waiting out the rest of an interval
        // it spent hidden: returning to a board a minute stale is the case this poll is least able to defend.
        watch(onScreen, (visible) => {
            syncLoop();
            if (visible && watchers > 0) {
                readAll(true);
            }
        }),
        // The sandbox list changing (one added, one removed, a switch moving a box in or out of `targets`)
        // re-reads whatever is newly in scope. `force: false` is what keeps a switch from re-reading four boxes
        // that answered seconds ago: only the box the user just LEFT is genuinely new to this store.
        watch(targets, () => {
            if (watchers > 0) {
                readAll(false);
            }
        }),
    ];
};

const stopWatching = (): void => {
    for (const stop of watching) {
        stop();
    }
    watching = [];
};

/* Start reading, and hand back the way to stop. Called by a surface on mount and disposed on unmount, so the
 * loop's lifetime is exactly the time something is looking at it. Reference counted, because two windows'
 * worth of surfaces, or a board and a ledger open at once, must not each start their own interval. */
export const subscribe = (): (() => void) => {
    watchers += 1;
    if (watchers === 1) {
        startWatching();
    }
    syncLoop();
    readAll(false);
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        watchers -= 1;
        if (watchers === 0) {
            stopWatching();
        }
        syncLoop();
    };
};

/* A caller's own "check now": the board's retry press, and the seam after an action landed on another box.
 * Bypasses `FRESH_MS`, which is the whole point of asking.
 *
 * A NO-OP WHEN NOTHING IS SUBSCRIBED, so the module's one rule holds without exception. Callers reach for this
 * from surfaces that may or may not be on screen (a land fired from the review page, a press on a board in
 * another window), and a "refresh" that spun up a round of requests for a store nobody is reading would be the
 * poll this design refuses, arriving by another door. */
export const refreshAcross = (): void => {
    if (watchers > 0) {
        readAll(true);
    }
};

// Every other sandbox, in the list's own order, whether or not it has answered yet. Surfaces render the ones
// that have not as unknown rather than dropping them: a box missing from a board reads as a box with no work.
export const otherBoxes = computed<readonly BoxFleet[]>(() =>
    targets.value.map(
        (sandbox) => boxes.value[sandbox.id] ?? { sandbox, state: `reading` as const, agents: [], held: [], readAt: undefined },
    ),
);

// The boxes that could not be reached on their last attempt, for the line a surface owes the reader when its
// answer is partial. Named separately rather than filtered at each call site: "three of five answered" is one
// fact, and two surfaces deriving it apart is how they come to disagree about it.
export const silentBoxes = computed<readonly BoxFleet[]>(() => otherBoxes.value.filter((box) => box.state === `unreachable`));

/* HOW MANY AGENTS IN ONE OTHER BOX WANT THE USER, the same reading `useAgents`' own `attention` makes of the
 * sandbox it streams: blocked, or finished with something unread, plus the automation wakes held at the door.
 * Derived here from the same leaf predicates rather than re-stated, because this number and the rail badge
 * that replaces it the moment you switch to that box are supposed to be the same number.
 *
 * UNDEFINED IS AN ANSWER, and the one this whole store is careful about: a box that has never told us anything
 * has no count, and rendering that as `0` would say "nothing is waiting for you here" on the strength of a
 * request that failed. Surfaces draw it as a dash. */
export const boxAttention = (box: BoxFleet): number | undefined => {
    if (box.readAt === undefined) {
        return undefined;
    }
    const unread = (agent: AgentSummary): boolean => !turnInFlight(agent) && agent.updatedAt > (agent.seenAt ?? 0);
    return box.agents.filter((agent) => blocked(agent) || unread(agent)).length + box.held.length;
};

/* READ IT WHERE IT LIVES. `useAgents.markSeen` writes the roster this browser streams, so it is a no-op for an
 * agent in another box: it looks the id up in the local registry, finds nothing, and returns. That was correct
 * while a distant agent could only be read from a card. It stopped being correct the moment a conversation
 * could be HELD here and run there (Conversation.box): a chat the user is sitting in front of would go on
 * counting toward "needs you" for good, which is the one thing a badge may never do.
 *
 * The optimistic patch matters as much as the POST: the next poll is up to 45 seconds away, and a count that
 * stays lit for that long after the user read the thing is indistinguishable from one that is stuck. Failures
 * are swallowed exactly as the local one swallows them, the next read is the correction. */
export const markSeenAcross = (sandboxId: string, agentId: string): void => {
    const box = boxes.value[sandboxId];
    if (box === undefined) {
        return;
    }
    const seenAt = Date.now();
    write(sandboxId, { sandbox: box.sandbox, agents: box.agents.map((agent) => (agent.id === agentId ? { ...agent, seenAt } : agent)) });
    void sandboxJsonQuietly(sandboxId, `/agents/${encodeURIComponent(agentId)}/seen`, { method: `POST` }).catch(() => undefined);
};

// The same count keyed by sandbox id, for the surfaces that hold a row rather than a box (the switcher).
export const attentionByBox = computed<ReadonlyMap<string, number | undefined>>(
    () => new Map(otherBoxes.value.map((box) => [box.sandbox.id, boxAttention(box)])),
);
