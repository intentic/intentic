import type { AgentSummary, TurnBreak, TurnBreakPolicy } from "@intentic/sandbox-contract";
import { standingFrom, unregistered } from "./agentStatus";
import { useChat } from "../../chat/run/useChat";
import { agentTabOf, type AgentTabSeed } from "../../chat/panel/useChat-reveal";
import { summonChat } from "../../chat/run/summon";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";
import type { FleetAgent } from "./useAgents-fleet";
import { underClaim } from "./useAgents-provisional";
import { markSeen, registry } from "./useAgents-registry";

// What one card can be told to do: per-agent writes (rename, posture override, resend, disarm a watch) and opening its
// chat. Each optimistic write stamps the roster entry in place and reverts against the current roster on refusal.

// Renames sync the open conversation's title ref first, then write the registry through the daemon. A card with no
// registry entry updates client-side only, best-effort posted to cover the send-to-first-roster-frame window.
export const rename = async (id: string, title: string): Promise<void> => {
    const trimmed = title.trim();
    const { conversations } = useChat();
    const conversation = conversations.value.find((candidate) => candidate.conversationId === id);
    const previousTitle = conversation?.title.value ?? null;
    if (conversation !== undefined) {
        conversation.title.value = trimmed;
    }
    const post = (): Promise<AgentSummary> =>
        sandboxJson<AgentSummary>(`/agents/${encodeURIComponent(id)}/rename`, jsonBody(`POST`, { title: trimmed }));
    const previous = registry.value.find((agent) => agent.id === id);
    if (previous === undefined) {
        void post().catch(() => undefined);
        return;
    }
    const revertTitle = previous.title;
    previous.title = trimmed; // registry is a deep ref: the in-place write repaints the fleet
    try {
        const summary = await post();
        registry.value = registry.value.map((agent) => (agent.id === id ? summary : agent));
    } catch (error) {
        // Revert on whatever the roster holds now: an SSE frame may have replaced the array (and `previous`).
        const target = registry.value.find((agent) => agent.id === id);
        if (target !== undefined) {
            target.title = revertTitle;
        }
        if (conversation !== undefined) {
            conversation.title.value = previousTitle;
        }
        throw error;
    }
};

// Sets or clears (null: inherit the sandbox setting) whether this agent's clean turns auto-land or wait for a
// deliberate Land. Same optimistic grammar as rename.
export const setAutoLand = async (id: string, autoLand: boolean | null): Promise<void> => {
    const previous = registry.value.find((agent) => agent.id === id);
    const revert = previous?.autoLand;
    if (previous !== undefined) {
        previous.autoLand = autoLand ?? undefined;
    }
    try {
        const summary = await sandboxJson<AgentSummary>(`/agents/${encodeURIComponent(id)}/auto-land`, jsonBody(`POST`, { autoLand }));
        registry.value = registry.value.map((agent) => (agent.id === id ? summary : agent));
    } catch (error) {
        const target = registry.value.find((agent) => agent.id === id);
        if (target !== undefined) {
            target.autoLand = revert;
        }
        throw error;
    }
};

// Sets or clears this conversation's answer for one ending (null goes back to following the sandbox-wide policy).
// One writer for all three, deliberately a sibling of setAutoLand rather than a settings call, since the choice is
// about one dead turn and not the sandbox-wide default. Reachable from the board as well as the chat: a limit reopens
// hours later, so the person deciding is often looking at a lane of stranded cards rather than one transcript.
export const setBreakPolicy = async (id: string, ending: TurnBreak, policy: TurnBreakPolicy | null): Promise<void> => {
    const previous = registry.value.find((agent) => agent.id === id);
    const revert = previous === undefined ? {} : policyPatch(ending, effectiveOn(previous, ending));
    if (previous !== undefined) {
        Object.assign(previous, policyPatch(ending, policy ?? undefined));
    }
    try {
        const summary = await sandboxJson<AgentSummary>(`/agents/${encodeURIComponent(id)}/break-policy`, jsonBody(`POST`, { ending, policy }));
        registry.value = registry.value.map((agent) => (agent.id === id ? summary : agent));
    } catch (error) {
        const target = registry.value.find((agent) => agent.id === id);
        if (target !== undefined) {
            Object.assign(target, revert);
        }
        throw error;
    }
};

// This agent's own answer for one ending, before the write, so a refusal puts back exactly what was there.
const effectiveOn = (agent: AgentSummary, ending: TurnBreak): TurnBreakPolicy | undefined =>
    ending === `limit` ? agent.limitPolicy : ending === `outage` ? agent.outagePolicy : agent.stopPolicy;

// The optimistic echo, narrowed to what the ending's field can hold: an answer that ending cannot take echoes as
// inherit, which is what the daemon refuses it as too.
const policyPatch = (ending: TurnBreak, policy: TurnBreakPolicy | undefined): Partial<AgentSummary> => {
    if (ending === `limit`) {
        return { limitPolicy: policy === `retry` ? undefined : policy };
    }
    const retry = policy === `retry` || policy === `wait` ? policy : undefined;
    return ending === `outage` ? { outagePolicy: retry } : { stopPolicy: retry };
};

// Sends a stranded turn again by re-running it, rather than appending a "carry on" message. The card runs from the
// press (useAgents-provisional) and goes back where it was if the daemon answers that it holds no such turn.
export const resumeHeldTurn = (id: string): Promise<void> =>
    underClaim(id, undefined, `turn`, async () => {
        await sandboxJson<{ run: string }>(`/agent/resume`, jsonBody(`POST`, { conversationId: id }));
    });

// Disarms outside conditions this conversation is parked on: all of them, or the one named. Optimistic, since dropping
// the watches is what moves the card out of Active; a press that waited for the round trip would leave the card sitting
// in the lane it was pressed out of.
export const stopWatching = async (id: string, watchId?: string): Promise<void> => {
    const previous = registry.value.find((agent) => agent.id === id);
    const revert = previous?.watches;
    if (previous !== undefined) {
        // An empty array is not absence: the registry reads absence as "never watched", which would redraw the card.
        const kept = watchId === undefined ? [] : (revert ?? []).filter((watch) => watch.id !== watchId);
        previous.watches = kept.length > 0 ? kept : undefined;
    }
    try {
        const body = watchId === undefined ? {} : { watchId };
        const summary = await sandboxJson<AgentSummary>(`/agents/${encodeURIComponent(id)}/stop-watching`, jsonBody(`POST`, body));
        registry.value = registry.value.map((agent) => (agent.id === id ? summary : agent));
    } catch (error) {
        const target = registry.value.find((agent) => agent.id === id);
        if (target !== undefined) {
            target.watches = revert;
        }
        throw error;
    }
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
});

// Opening a card is a summons, not a store call, since the chat panel showing it may be another window's. A plain click
// is a look (`peek`), swept the moment you point elsewhere; anything more deliberate says `keep`, the default.
export const open = (agent: Parameters<typeof agentSeed>[0], mode: "peek" | "keep" = `keep`): void => {
    const seed = agentSeed(agent);
    summonChat({ kind: `reveal`, verb: `show`, entries: [agentTabOf(seed)], focus: seed.id, caret: false, peek: mode === `peek` });
    markSeen(agent.id);
};
