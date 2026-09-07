import type { AgentSummary, AutomationApproval } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { blocked, turnInFlight } from "../../agents/fleet/agentStatus";
import { queryClient } from "../../../lib/queryPersistence";
import { AGENTS } from "../../../lib/queryKeys";
import { sandboxJsonQuietly } from "../client/sandboxClient";
import { type AcrossRecord, createAcrossStore } from "./acrossSandboxes";

/* WHAT EVERY OTHER SANDBOX IS DOING, for the fleet board's All-sandboxes scope and the switcher's counts.
 *
 * The reading loop is acrossSandboxes.ts and its rules are stated there once (pull rather than stream, never
 * wake a machine, run only while something is watching, never answer 0 for "don't know"). What is here is the
 * part specific to this question: what a box's fleet looks like, and what a count of it means.
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

export interface BoxFleet extends AcrossRecord {
    readonly state: BoxState;
    readonly agents: readonly AgentSummary[];
    readonly held: readonly AutomationApproval[];
}

const store = createAcrossStore<BoxFleet>({
    pollMs: POLL_MS,
    freshMs: FRESH_MS,
    blank: (sandbox) => ({ sandbox, state: `reading`, agents: [], held: [], readAt: undefined }),
    // Only a box that has never answered shows as reading; every other one keeps what it was.
    reading: (previous) => ({ state: previous === undefined || previous.readAt === undefined ? `reading` : previous.state }),
    unreachable: () => ({ state: `unreachable` }),
    read: async (sandbox) => {
        const body = await sandboxJsonQuietly<{ agents: AgentSummary[]; rev: number; held?: AutomationApproval[] }>(sandbox.id, `/agents`);
        /* Filed in the shared cache under this sandbox's own key as well as in the store above. Nothing reads
         * it from there yet; what it buys is that these entries are swept by exactly the machinery that sweeps
         * every other per-sandbox entry, `sandboxQueryPredicate` finds them by the id in the last position, so
         * a workspace replaced under one of these boxes drops this browser's account of its fleet with
         * everything else it remembered about it. A store that quietly opted out of that would be the one
         * surface still painting a workspace that no longer exists. */
        queryClient.setQueryData(AGENTS.ofSandbox(sandbox.id), body.agents);
        return { state: `ready`, agents: body.agents, held: body.held ?? [] };
    },
});

export const subscribe = store.subscribe;
export const refreshAcross = store.refresh;

// Every other sandbox, in the list's own order, whether or not it has answered yet. Surfaces render the ones
// that have not as unknown rather than dropping them: a box missing from a board reads as a box with no work.
export const otherBoxes = store.entries;

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
    const box = store.get(sandboxId);
    if (box === undefined) {
        return;
    }
    const seenAt = Date.now();
    store.patch(sandboxId, { sandbox: box.sandbox, agents: box.agents.map((agent) => (agent.id === agentId ? { ...agent, seenAt } : agent)) });
    void sandboxJsonQuietly(sandboxId, `/agents/${encodeURIComponent(agentId)}/seen`, { method: `POST` }).catch(() => undefined);
};

// The same count keyed by sandbox id, for the surfaces that hold a row rather than a box (the switcher).
export const attentionByBox = computed<ReadonlyMap<string, number | undefined>>(
    () => new Map(otherBoxes.value.map((box) => [box.sandbox.id, boxAttention(box)])),
);
