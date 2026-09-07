import type { AgentSummary } from "@intentic/sandbox-contract";
import { unregistered } from "./agentStatus";
import { useChat } from "../../chat/run/useChat";
import { agentTabOf, type AgentTabSeed } from "../../chat/panel/useChat-reveal";
import { summonChat } from "../../chat/run/summon";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";
import type { FleetAgent } from "./useAgents-fleet";
import { markSeen, registry } from "./useAgents-registry";

/* WHAT ONE CARD CAN BE TOLD TO DO: the per-agent writes (a rename, a posture override, a stranded turn sent
 * again, a watch disarmed) and opening its chat. Each optimistic write stamps the roster entry IN PLACE and
 * reverts against the CURRENT roster on refusal; see the fingerprint note in useAgents-registry for why that
 * in-place write is what every surface repaints on, and why it self-heals. */

// Rename an agent: sync the open conversation's title ref first (docked tab, detail header, and the
// localStorage tab snapshot all follow it), then write the registry through the daemon. A card with no
// registry entry is a draft, its title lives client-side and rides the next turn body, but the POST still
// fires best-effort to cover the send→first-roster-frame window where the entry exists but hasn't painted.
// Registered agents update optimistically; on failure both sides revert (re-resolved against the CURRENT
// roster, an SSE frame may have replaced it mid-flight) and the error propagates to the caller's inline UI.
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
        // Revert on whatever the roster holds NOW, an SSE frame may have replaced the array (and `previous`).
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

// Set or clear (null ⇒ inherit the sandbox setting) an agent's auto-land override, whether ITS clean turns
// keep applying to the workspace at completion, or wait on the branch for a deliberate Land. Same optimistic
// grammar as rename: the registry entry flips in place (every surface stating the posture repaints on the
// tick of the click), the daemon's summary replaces it, and a failure reverts against the CURRENT roster and
// propagates for the caller's inline reporting.
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

/* Set or clear (null ⇒ inherit the sandbox setting) THIS conversation's outage-resume override, whether a
 * turn the model provider killed is picked back up by itself. Identical optimistic grammar to setAutoLand
 * above, and deliberately a sibling of it rather than a call into settings: the press this serves is made
 * inside one chat about one dead turn, and writing the sandbox-wide toggle for it, which is what used to
 * happen, armed every other agent on the board without ever saying so. */
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

/* The same override for the blocker that comes back on a clock: whether the turn a spent allowance refused is
 * sent again by itself when the window reopens. Same optimistic grammar as its neighbour above, and the same
 * scope argument, one card's press speaks for one card.
 *
 * The press this serves is on the BOARD as well as in the chat, which is the one thing that differs and the
 * reason it matters: an outage is over in minutes and is met by whoever is in the room, while an allowance
 * reopens hours later, so the person deciding is usually looking at a lane of stranded cards rather than at the
 * transcript of any one of them. */
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

/* The third posture of the same grammar: whether a spent allowance MOVES this conversation's held turn to another
 * account of the same provider with room, the moment the refusal lands (SandboxSettings.moveAfterLimit has the
 * policy and what a move costs). Same optimistic write, same one-card scope. */
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

/* SEND A STRANDED TURN AGAIN, the board's half of the chat's pick-up strip: the daemon is still holding the
 * turn a spent allowance refused, so this re-RUNS that turn rather than appending a message saying "carry on"
 * (agent.contract's `resume`, and events.ts's `held` for the transcript full of the word "Continue" that
 * argument was won with).
 *
 * NOT optimistic, unlike its neighbours above. Those write a posture, where the honest thing to show while the
 * request is in flight is the value the user just chose; this starts a TURN, and the card that says so is the
 * one the daemon frames a moment later. Guessing would put a running card on the board over a request that may
 * yet answer NOT_FOUND, which is exactly what a hold lost to a daemon restart does. */
export const resumeHeldTurn = async (id: string): Promise<void> => {
    await sandboxJson<{ run: string }>(`/agent/resume`, jsonBody(`POST`, { conversationId: id }));
};

/* DISARM EVERY OUTSIDE CONDITION THIS CONVERSATION IS PARKED ON (AgentSummary.watches), the user's way out of
 * an arrangement the agent entered into on their behalf.
 *
 * Optimistic like its two neighbours above, and for a sharper reason than symmetry: this press moves the card
 * across the board. Dropping the watches is what takes the conversation out of Active (agentStatus.laneOf), so
 * a press that waited on the round trip would leave the card sitting in the lane it was pressed out of, wearing
 * a readout that says it is still waiting. Reverted the same way if the daemon refuses, since a card that
 * quietly stopped mentioning a watch that is still armed is the exact failure this whole feature exists to
 * remove. */
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

// Open (or focus) an agent's conversation tab and mark it seen. Takes just the identity fields so registry
// cards and client-only draft cards both route through it.
// A card, as the seed every window can rebuild its tab from (useChat.agentTabOf takes it from here).
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
    // The box the card came from, so a tab opened for an agent in another sandbox is addressed there rather
    // than asking this daemon about a conversation it has never heard of (AgentTabSeed.sandboxId).
    ...(agent.sandboxId !== undefined ? { sandboxId: agent.sandboxId } : {}),
    ...(agent.branch !== undefined ? { branch: agent.branch } : {}),
    /* A client-only card, a draft, a refused send, a turn the daemon has not filed yet, is NOT a
     * registered conversation, and claiming so here would erase the card under the click and pin the empty
     * tab open past the focus-leave sweep.
     *
     * The erasure is not hypothetical: while a sent-but-unfiled turn reported the wire's `running`, this
     * read it as registered and latched the tab, and the card left the board on the very click meant to open
     * it, the drafts half skips a registered conversation and the registry has no entry to draw instead, so
     * the agent was on no lane at all until a reload re-derived it. See `starting` in agentStatus.ts. */
    registered: !unregistered(agent.status),
    ...(agent.sessionId !== undefined ? { sessionId: agent.sessionId } : {}),
    ...(agent.title !== undefined ? { title: agent.title } : {}),
    ...(agent.account !== undefined ? { account: agent.account } : {}),
    // The settings this agent's turns ran under, so the composer opens describing THIS agent rather than
    // the last pick made in some other tab. Absent on a draft, it has run nothing to describe.
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
    ...(agent.thinking !== undefined ? { thinking: agent.thinking } : {}),
    ...(agent.fast !== undefined ? { fast: agent.fast } : {}),
    ...(agent.tier !== undefined ? { tier: agent.tier } : {}),
    ...(agent.tierHold !== undefined ? { tierHold: agent.tierHold } : {}),
});

/* Opening a card is a SUMMONS, not a store call: the chat panel showing the result may be another window's (the
 * chat can be floating in a window of its own), so the reveal is broadcast and every window, this one included,
 * applies the same thing (summon.ts).
 *
 * A PLAIN CLICK ON A CARD IS A LOOK (`peek`), the mode the workspace editor opens a file in when you single-click
 * it in the tree: the tab lives while you are reading it and is swept the moment you point at something else, so
 * skimming a lane of forty agents costs the chat one tab rather than forty. The gestures that mean more than a
 * look, opening the review, sending it a message, giving it a column, say `keep`, which is the default here on
 * purpose: a caller that has not thought about it is doing something deliberate. What a peek promises is only
 * possible because closing a chat's tab destroys nothing (see Conversation.peek). */
export const open = (agent: Parameters<typeof agentSeed>[0], mode: "peek" | "keep" = `keep`): void => {
    const seed = agentSeed(agent);
    summonChat({ kind: `reveal`, verb: `show`, entries: [agentTabOf(seed)], focus: seed.id, caret: false, peek: mode === `peek` });
    markSeen(agent.id);
};
