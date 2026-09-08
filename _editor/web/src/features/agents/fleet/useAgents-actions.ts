import type { AgentSummary } from "@intentic/sandbox-contract";
import { unregistered } from "./agentStatus";
import { useChat } from "../../chat/run/useChat";
import { agentTabOf, type AgentTabSeed } from "../../chat/panel/useChat-reveal";
import { summonChat } from "../../chat/run/summon";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";
import type { FleetAgent } from "./useAgents-fleet";
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

// Sets or clears this conversation's outage-resume override; deliberately a sibling of setAutoLand rather than a
// settings call, since the press is about one dead turn, not the sandbox-wide default.
export const setResumeAfterOutage = async (id: string, resumeAfterOutage: boolean | null): Promise<void> => {
    const previous = registry.value.find((agent) => agent.id === id);
    const revert = previous?.resumeAfterOutage;
    if (previous !== undefined) {
        previous.resumeAfterOutage = resumeAfterOutage ?? undefined;
    }
    try {
        const summary = await sandboxJson<AgentSummary>(
            `/agents/${encodeURIComponent(id)}/resume-after-outage`,
            jsonBody(`POST`, { resumeAfterOutage }),
        );
        registry.value = registry.value.map((agent) => (agent.id === id ? summary : agent));
    } catch (error) {
        const target = registry.value.find((agent) => agent.id === id);
        if (target !== undefined) {
            target.resumeAfterOutage = revert;
        }
        throw error;
    }
};

// The same override for a clock-based blocker: whether a spent-allowance refusal resends itself when the window
// reopens. Reachable from the board too, since the person deciding is often looking at a lane of stranded cards rather
// than one transcript.
export const setResumeAfterLimit = async (id: string, resumeAfterLimit: boolean | null): Promise<void> => {
    const previous = registry.value.find((agent) => agent.id === id);
    const revert = previous?.resumeAfterLimit;
    if (previous !== undefined) {
        previous.resumeAfterLimit = resumeAfterLimit ?? undefined;
    }
    try {
        const summary = await sandboxJson<AgentSummary>(
            `/agents/${encodeURIComponent(id)}/resume-after-limit`,
            jsonBody(`POST`, { resumeAfterLimit }),
        );
        registry.value = registry.value.map((agent) => (agent.id === id ? summary : agent));
    } catch (error) {
        const target = registry.value.find((agent) => agent.id === id);
        if (target !== undefined) {
            target.resumeAfterLimit = revert;
        }
        throw error;
    }
};

// The third posture of the same grammar: whether a spent allowance moves this conversation's held turn to another
// account with room, the moment the refusal lands.
export const setMoveAfterLimit = async (id: string, moveAfterLimit: boolean | null): Promise<void> => {
    const previous = registry.value.find((agent) => agent.id === id);
    const revert = previous?.moveAfterLimit;
    if (previous !== undefined) {
        previous.moveAfterLimit = moveAfterLimit ?? undefined;
    }
    try {
        const summary = await sandboxJson<AgentSummary>(`/agents/${encodeURIComponent(id)}/move-after-limit`, jsonBody(`POST`, { moveAfterLimit }));
        registry.value = registry.value.map((agent) => (agent.id === id ? summary : agent));
    } catch (error) {
        const target = registry.value.find((agent) => agent.id === id);
        if (target !== undefined) {
            target.moveAfterLimit = revert;
        }
        throw error;
    }
};

// Sends a stranded turn again by re-running it, rather than appending a "carry on" message. Not optimistic, unlike its
// neighbours: this starts a turn, and guessing would show a running card over a request that may still answer
// NOT_FOUND.
export const resumeHeldTurn = async (id: string): Promise<void> => {
    await sandboxJson<{ run: string }>(`/agent/resume`, jsonBody(`POST`, { conversationId: id }));
};

// Disarms every outside condition this conversation is parked on. Optimistic, since dropping the watches is what moves
// the card out of Active; a press that waited for the round trip would leave the card sitting in the lane it was
// pressed out of.
export const stopWatching = async (id: string): Promise<void> => {
    const previous = registry.value.find((agent) => agent.id === id);
    const revert = previous?.watches;
    if (previous !== undefined) {
        previous.watches = undefined;
    }
    try {
        const summary = await sandboxJson<AgentSummary>(`/agents/${encodeURIComponent(id)}/stop-watching`, jsonBody(`POST`, {}));
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
        | "tier"
        | "tierHold"
        | "status"
        | "branch"
        | "sandboxId"
    >,
): AgentTabSeed => ({
    id: agent.id,
    provider: agent.provider,
    harness: agent.harness,
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
    ...(agent.tier !== undefined ? { tier: agent.tier } : {}),
    ...(agent.tierHold !== undefined ? { tierHold: agent.tierHold } : {}),
});

// Opening a card is a summons, not a store call, since the chat panel showing it may be another window's. A plain click
// is a look (`peek`), swept the moment you point elsewhere; anything more deliberate says `keep`, the default.
export const open = (agent: Parameters<typeof agentSeed>[0], mode: "peek" | "keep" = `keep`): void => {
    const seed = agentSeed(agent);
    summonChat({ kind: `reveal`, verb: `show`, entries: [agentTabOf(seed)], focus: seed.id, caret: false, peek: mode === `peek` });
    markSeen(agent.id);
};
