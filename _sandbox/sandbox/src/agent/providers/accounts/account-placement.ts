import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { roomiestAccount } from "@intentic/sandbox-contract/models/plan-pools";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import { PROMPT_CACHE_1H_MS } from "../../run/turn/prompt-cache.js";
import { namedServiceabilities, type ServiceabilityDeps } from "../../../usage/serviceability/serviceability.js";
import type { AccountRoute } from "./blocked-account.js";

/* WHERE A CONVERSATION RUNS ONCE ITS CACHE IS COLD. An account pays for a turn and keeps one thing for the next: the
   provider's prompt cache, which lives on that account. Once the cache has expired, nothing ties the conversation to the
   account any more. The session is carried to wherever the turn runs (turn-plan.ts: the move is the conversation's, and
   the session frame binds it there), so moving costs no more than staying. A conversation nobody pinned is then run on
   the account with the most room, rather than on whichever one it happened to start on. That spreads the load, and it
   moves conversations off an account about to run out before that account refuses them.

   Asked after blocked-account.ts, which moves a turn off an account that cannot serve it, pinned or not. This rule only
   re-places an account that still can serve:
   - a turn that names its account, a conversation with no account on file, or a routed provider (it balances its own
     credentials) is left where routing points;
   - an account a person pinned (switch-account.ts) stays while it can serve, warm or cold;
   - a warm cache stays, since moving would throw away what it holds;
   - a cold cache moves only for a clear gain: at least REPLACE_GAP points more room, or any gain over an account nearly
     out. Small differences in room are ignored, so the chat does not fill up with move lines.
   An account nothing has measured is usable but never read as room, so it neither moves nor is moved onto. */

// How much more room, in percentage points of the fullest pool, makes a cold move worth a line in the chat.
export const REPLACE_GAP = 20;
// Room at or below this is an account about to run out: any account with more is worth moving to while the cache is cold.
export const NEAR_SPENT = 10;

/** What the planner knows of the conversation's cache: when it was last written, and how long it lives, where known. */
export interface CacheState {
    readonly at: number;
    readonly ttlMs: number;
}

/**
 * Whether the cache the conversation's next turn would read has expired. A known lifetime decides it. With none known (a
 * provider that publishes none, or a daemon that restarted since), the cache counts as cold once the conversation has been
 * quiet for the longest lifetime any provider offers. With no record of activity at all, it counts as cold.
 */
export const cacheCold = (cache: CacheState | undefined, lastAt: number | undefined, now: number): boolean => {
    if (cache !== undefined) {
        return now >= cache.at + cache.ttlMs;
    }
    return lastAt === undefined || now - lastAt >= PROMPT_CACHE_1H_MS;
};

export interface ColdTurn {
    readonly provider: AgentProvider;
    // What the turn itself names; undefined is no choice made for this turn.
    readonly named: string | undefined;
    // The account on file for the conversation, as routingFor fills it in.
    readonly remembered: string | undefined;
    // Whether a person pinned the remembered account (agents-store.ts pinnedAccount).
    readonly pinned: boolean;
    readonly cold: boolean;
    readonly model: string | undefined;
}

const roomWords = (room: number): string => `${String(room)}% left`;

/** Where a cold, unpinned conversation goes: keep, or a move onto an account with clearly more room. */
export const placeCold = async (deps: ServiceabilityDeps, turn: ColdTurn): Promise<AccountRoute> => {
    const { provider, named, remembered, pinned, cold, model } = turn;
    if (named !== undefined || remembered === undefined || pinned || !cold || KeyedProviderSchema.safeParse(provider).success) {
        return { kind: "keep" };
    }
    const rows = await namedServiceabilities(deps, provider, model === undefined || model === "" ? undefined : { id: model });
    const current = rows.find((row) => row.id === remembered);
    if (current?.state.kind !== "ready") {
        return { kind: "keep" };
    }
    const best = roomiestAccount(rows.filter((row) => row.id !== remembered));
    if (best?.state.kind !== "ready") {
        return { kind: "keep" };
    }
    const here = current.state.room;
    const there = best.state.room;
    const worth = there - here >= REPLACE_GAP || (here <= NEAR_SPENT && there > here);
    if (!worth) {
        return { kind: "keep" };
    }
    return {
        kind: "move",
        from: remembered,
        to: best.id,
        labels: { from: current.label, to: best.label },
        reason: `"${current.label}" had ${roomWords(here)} and "${best.label}" ${roomWords(there)}; the cache had gone cold, so moving cost nothing`,
        cold: true,
    };
};
