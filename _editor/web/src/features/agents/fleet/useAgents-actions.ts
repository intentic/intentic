import type { AgentSummary, TurnBreak, TurnBreakPolicy } from "@intentic/sandbox-contract";
import { standingFrom, unregistered } from "./agentStatus";
import { useChat } from "../../chat/run/useChat";
import { agentTabOf, type AgentTabSeed } from "../../chat/panel/useChat-reveal";
import { summonChat } from "../../chat/run/summon";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { agentById, type FleetAgent } from "./useAgents-fleet";
import { optimistic, underClaim } from "./useAgents-provisional";
import { markSeen, registry } from "./useAgents-registry";

// What one card can be told to do: per-agent writes (rename, posture override, resend, disarm a watch) and opening its
// chat. Each write is drawn from the press (useAgents-provisional.optimistic) and gives way to the daemon's answer.

// The open tab's title moves first; a card with no registry entry has no roster write, only a best-effort post covering
// the send-to-first-roster-frame window.
export const rename = async (id: string, title: string): Promise<void> => {
    const trimmed = title.trim();
    const conversation = useChat().conversations.value.find((candidate) => candidate.conversationId === id);
    const previousTitle = conversation?.title.value ?? null;
    if (conversation !== undefined) {
        conversation.title.value = trimmed;
    }
    const post = (): Promise<AgentSummary> => sandboxRpc.agents.rename({ id, title: trimmed });
    if (!registry.value.some((agent) => agent.id === id)) {
        void post().catch(() => undefined);
        return;
    }
    try {
        await optimistic(id, { title: trimmed }, post);
    } catch (error) {
        if (conversation !== undefined) {
            conversation.title.value = previousTitle;
        }
        throw error;
    }
};

// Sets or clears (null: inherit the sandbox setting) whether this agent's clean turns auto-land or wait for a Land.
export const setAutoLand = (id: string, autoLand: boolean | null): Promise<void> =>
    optimistic(id, { autoLand: autoLand ?? undefined }, () => sandboxRpc.agents.autoLand({ id, autoLand }));

// Sets or clears (null: follow the sandbox-wide policy) this conversation's answer for one ending; a write about one
// dead turn rather than a settings call, and reachable from the board, where stranded cards are usually read.
export const setBreakPolicy = (id: string, ending: TurnBreak, policy: TurnBreakPolicy | null): Promise<void> =>
    optimistic(id, policyPatch(ending, policy ?? undefined), () => sandboxRpc.agents.breakPolicy({ id, ending, policy }));

// Keeps this conversation's prompt cache warm until `until`, or stops (null); the daemon shortens `until` to what it can keep, so only a stop is drawn before it answers.
export const setKeepWarm = (id: string, until: number | null): Promise<void> =>
    optimistic(id, until === null ? { keepWarm: undefined } : {}, () => sandboxRpc.agents.keepWarm({ id, until }));

// The echo narrowed to what the ending's field can hold: an answer that ending cannot take echoes as inherit, which is
// what the daemon refuses it as too.
const policyPatch = (ending: TurnBreak, policy: TurnBreakPolicy | undefined): Partial<AgentSummary> => {
    if (ending === `limit`) {
        return { limitPolicy: policy === `retry` ? undefined : policy };
    }
    const retry = policy === `retry` || policy === `wait` ? policy : undefined;
    return ending === `outage` ? { outagePolicy: retry } : { stopPolicy: retry };
};

// Sends a stranded turn again by re-running it, rather than appending a "carry on" message. The card runs from the
// press and goes back where it was if the daemon answers that it holds no such turn.
export const resumeHeldTurn = (id: string): Promise<void> =>
    underClaim(id, undefined, `turn`, async () => {
        await sandboxRpc.agent.resume({ conversationId: id });
    });

// Disarms outside conditions this conversation is parked on: all of them, or the one named. Drawn from the press, since
// dropping the watches is what moves the card out of Active.
export const stopWatching = (id: string, watchId?: string): Promise<void> => {
    const held = agentById(id)?.watches ?? [];
    const kept = watchId === undefined ? [] : held.filter((watch) => watch.id !== watchId);
    // An empty array is not absence: the registry reads absence as "never watched", which would redraw the card.
    return optimistic(id, { watches: kept.length > 0 ? kept : undefined }, () => sandboxRpc.agents.stopWatching({ id, watchId }));
};

// Opens or focuses an agent's tab and marks it seen; takes just the identity fields so registry cards and client-only
// draft cards both route through it.
export const agentSeed = (
    agent: Pick<
        FleetAgent,
        | "id"
        | "provider"
        | "harness"
        | "sessionId"
        | "title"
        | "account"
        | "model"
        | "effort"
        | "thinking"
        | "fast"
        | "actsAs"
        | "status"
        | "branch"
        | "sandboxId"
        | "attention"
        | "watches"
        | "failureCode"
        | "limitResetsAt"
        | "limitHeld"
        | "limitScheduled"
        | "limitMoving"
    >,
): AgentTabSeed => ({
    id: agent.id,
    provider: agent.provider,
    harness: agent.harness,
    // Where this card stands, carried so the chat lands in the same lane in a window whose roster hasn't answered
    // for the agent yet.
    standing: standingFrom(agent),
    // The box the card came from, so a tab for an agent in another sandbox is addressed there rather than asked of this
    // daemon.
    ...(agent.sandboxId !== undefined ? { sandboxId: agent.sandboxId } : {}),
    ...(agent.branch !== undefined ? { branch: agent.branch } : {}),
    // A client-only card (a draft, a refused send, an unfiled turn) is not a registered conversation; claiming so here
    // erases the card under the click and pins the empty tab open past the focus-leave sweep.
    registered: !unregistered(agent.status),
    ...(agent.sessionId !== undefined ? { sessionId: agent.sessionId } : {}),
    ...(agent.title !== undefined ? { title: agent.title } : {}),
    ...(agent.account !== undefined ? { account: agent.account } : {}),
    // The settings this agent's turns ran under, so the composer describes this agent, not the last pick made
    // elsewhere.
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
    ...(agent.thinking !== undefined ? { thinking: agent.thinking } : {}),
    ...(agent.fast !== undefined ? { fast: agent.fast } : {}),
    ...(agent.actsAs !== undefined ? { actsAs: agent.actsAs } : {}),
});

// Opening a card is a summons, not a store call, since the chat panel showing it may be another window's. A plain click
// is a look (`peek`), swept the moment you point elsewhere; anything more deliberate says `keep`, the default.
export const open = (agent: Parameters<typeof agentSeed>[0], mode: "peek" | "keep" = `keep`): void => {
    const seed = agentSeed(agent);
    summonChat({ kind: `reveal`, verb: `show`, entries: [agentTabOf(seed)], focus: seed.id, caret: false, peek: mode === `peek` });
    markSeen(agent.id);
};
