import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { reportsPlanLimits } from "@intentic/sandbox-contract/models/agent-catalog";
import { moveDestination } from "@intentic/sandbox-contract/models/account-moves";
import { bestWithRoom, NEARLY_OUT_ROOM } from "@intentic/sandbox-contract/models/plan-pools";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import { PROMPT_CACHE_1H_MS } from "../../run/turn/prompt-cache.js";
import { namedServiceabilities, type ServiceabilityDeps } from "../../../usage/serviceability/serviceability.js";
import type { AccountRoute } from "./blocked-account.js";

/* WHERE A CONVERSATION RUNS ONCE ITS CACHE IS COLD. An account pays for a turn and keeps one thing for the next: the
   provider's prompt cache, which lives on that account. Once the cache has expired, nothing ties the conversation to the
   account any more. The session is carried to wherever the turn runs (turn-plan.ts: the move is the conversation's, and
   the session frame binds it there), so moving costs no more than staying. A conversation nobody pinned is then run on
   the account the sandbox's pick prefers (plan-pools.ts preferredAccount: the allowance that renews first, unless it is
   nearly out), rather than on whichever one it happened to start on. That spends what would otherwise reset unspent,
   and it moves conversations off an account about to run out before that account refuses them.

   Asked after blocked-account.ts, which moves a turn off an account that cannot serve it, pinned or not. This rule only
   re-places an account that still can serve:
   - a turn that names its account, a conversation with no account on file, or a routed provider (the daemon's gateway
     places each of its requests on an account, translator-gateway.ts) is left where routing points;
   - an account a person pinned (switch-account.ts) stays while it can serve, warm or cold;
   - a warm cache stays, since moving would throw away what it holds;
   - a cold cache moves only for a clear gain: any gain over an account nearly out; onto an account not nearly out whose
     allowance renews at least RENEW_GAP_HOURS sooner; or, between two that renew within that of each other, at least
     REPLACE_GAP points more room. Small differences are ignored, so the chat does not fill up with move lines, and
     never toward an account renewing later than this one, which would leave this one's allowance to reset unspent.
   An account nothing has measured is usable but never read as room, so it neither moves nor is moved onto. */

// How much more room, in percentage points of the fullest pool, makes a cold move worth a line in the chat.
export const REPLACE_GAP = 20;
// Room at or below this is an account about to run out: any account with more is worth moving to while the cache is cold.
export const NEAR_SPENT = NEARLY_OUT_ROOM;
// How much sooner another account's allowance must renew for a cold move onto it: weekly resets fall across the week, and
// a few hours' difference is not worth a line in the chat.
export const RENEW_GAP_HOURS = 12;

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

// When an allowance renews, said from now: "renewing in 10 hours", "renewing in 6 days".
const renewWords = (renewsAt: number | undefined, now: number): string => {
    if (renewsAt === undefined) {
        return "no known reset";
    }
    const hours = Math.max(1, Math.round((renewsAt * 1000 - now) / 3_600_000));
    return hours < 48 ? `renewing in ${String(hours)} hour${hours === 1 ? "" : "s"}` : `renewing in ${String(Math.round(hours / 24))} days`;
};

type Ready = AccountState & { kind: "ready" };

// Why a cold conversation is worth moving from `here` to `there`, or undefined to keep it (the rules in the header).
const coldGain = (here: Ready, there: Ready): "nearly-out" | "renews-sooner" | "room" | undefined => {
    if (here.room <= NEAR_SPENT && there.room > here.room) {
        return "nearly-out";
    }
    // How many hours sooner the destination renews; undefined where either reset is unknown, which reads as no difference.
    const sooner = here.renewsAt === undefined || there.renewsAt === undefined ? undefined : (here.renewsAt - there.renewsAt) / 3_600;
    if (sooner !== undefined && sooner >= RENEW_GAP_HOURS && there.room > NEAR_SPENT) {
        return "renews-sooner";
    }
    const alike = sooner === undefined || Math.abs(sooner) < RENEW_GAP_HOURS;
    return alike && there.room - here.room >= REPLACE_GAP ? "room" : undefined;
};

/** Where a cold, unpinned conversation goes: keep, or a move onto an account clearly better to spend now. */
export const placeCold = async (deps: ServiceabilityDeps, turn: ColdTurn, now: number = Date.now()): Promise<AccountRoute> => {
    const { provider, named, remembered, pinned, cold, model } = turn;
    if (named !== undefined || remembered === undefined || pinned || !cold || KeyedProviderSchema.safeParse(provider).success) {
        return { kind: "keep" };
    }
    const rows = await namedServiceabilities(deps, provider, model === undefined || model === "" ? undefined : { id: model });
    const current = rows.find((row) => row.id === remembered);
    if (current?.state.kind !== "ready") {
        return { kind: "keep" };
    }
    const best = bestWithRoom(rows.filter((row) => row.id !== remembered));
    if (best?.state.kind !== "ready") {
        return { kind: "keep" };
    }
    const gain = coldGain(current.state, best.state);
    if (gain === undefined) {
        return { kind: "keep" };
    }
    const why =
        gain === "renews-sooner"
            ? `"${best.label}" had ${roomWords(best.state.room)}, ${renewWords(best.state.renewsAt, now)}, and "${current.label}" ${renewWords(current.state.renewsAt, now)}`
            : `"${current.label}" had ${roomWords(current.state.room)} and "${best.label}" ${roomWords(best.state.room)}`;
    return {
        kind: "move",
        from: remembered,
        to: best.id,
        labels: { from: current.label, to: best.label },
        reason: `${why}; the cache had gone cold, so moving cost nothing`,
        cold: true,
    };
};

/* OFF AN ACCOUNT THE RECORDS CALL SPENT, BEFORE THE TURN IS SENT TO BE REFUSED. Asked after blocked-account.ts and before
   placeCold, for the account the conversation remembers, pinned or not: a pin holds while the account can serve, and a
   spent one cannot. A person's press always went out, so a conversation placed on an account whose allowance was spent
   was refused on every press while the provider's other accounts sat idle: a Devin chat was refused twice in half an hour
   with two accounts beside it nothing had refused (2026-10-29). It goes where every move goes (account-moves.ts
   moveDestination): proven room, or where the provider publishes no allowance, an account nothing has refused. With
   nowhere to go it stays, and the provider's own refusal says why. A turn naming another account is never asked, nor one
   a person picked the account for (turn-facts.ts accountRouteOf): the records are not always right. */

/** Where a conversation remembering a spent account goes: keep, or a move onto the account the move rule picks. */
export const offSpentAccount = async (deps: ServiceabilityDeps, turn: Pick<ColdTurn, "provider" | "named" | "remembered" | "model">): Promise<AccountRoute> => {
    const { provider, named, remembered, model } = turn;
    if (named !== undefined || remembered === undefined || KeyedProviderSchema.safeParse(provider).success) {
        return { kind: "keep" };
    }
    const rows = await namedServiceabilities(deps, provider, model === undefined || model === "" ? undefined : { id: model });
    const current = rows.find((row) => row.id === remembered);
    if (current?.state.kind !== "spent") {
        return { kind: "keep" };
    }
    const to = moveDestination(
        rows.filter((row) => row.id !== remembered),
        reportsPlanLimits(provider),
    );
    if (to === undefined) {
        return { kind: "keep" };
    }
    return {
        kind: "move",
        from: remembered,
        to: to.id,
        labels: { from: current.label, to: to.label },
        reason: `"${current.label}" has used up its allowance, and "${to.label}" ${to.state.kind === "ready" ? `has ${roomWords(to.state.room)}` : "has not been refused"}`,
        spent: true,
    };
};
