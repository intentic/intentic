import type { AgentChangesResponse } from "@intentic-app/api-contract";
import type { AgentSpan, AgentSummary, LandMode, LandResult } from "@intentic/sandbox-contract";
import { useDevice } from "@intentic/ui";
import type { Conversation } from "../chat/conversation";
import { summonChat } from "../chat/summon";
import { composingConversation, draftConversation, useChat } from "../chat/useChat";
import { queryClient } from "../queryPersistence";
import { router } from "../../router";
import { sandboxJson } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";
import { useSandbox } from "../sandbox/useSandbox";
import { agentBlockers, blockersOf, resolvePrompt, userBlockers } from "./conflictResolution";
import { markAgentStarted } from "./firstRun";
import { useAgents } from "./useAgents";
import { AGENTS, GIT_CHANGES, HISTORY_SNAPSHOTS } from "../queryKeys";

/* The fleet's mutations, addressed by agent id — the true source for both surfaces that invoke them: the
 * review panel (useAgentChanges, which binds one agent to its diff query) and the board's drag-to-act drops,
 * which act on whichever card was dropped and own no query at all. Land and discard are refused daemon-side
 * while the agent's turn is running: the worktree is that turn's live working state. */

// "New agent", as ONE action for every surface that offers it: the board's header button and its empty state,
// the chat strip's "+", and the mobile strip's "+". They all mean the same thing — a fresh isolated
// conversation, focused and ready to type into — so they must all do the same thing, whole. That is three
// steps, and a surface that skips any of them reads as a press that did nothing:
//   · summon the tab, in EVERY window (the fleet's draft card and the chat's tab are the same conversation
//     under two skins, and the chat panel showing it may be another window's — see summon.ts)
//   · put the caret in its composer, which is what makes the new tab visible as the thing you now type into
//     (the summons' caret flag)
//   · on mobile, go to it — there is no docked chat there, so the agent's own screen IS the result (and a "+"
//     pressed from an agent's screen would otherwise leave the route pointing at the agent you just left)
//
// A press over an existing untouched draft summons THAT draft (useChat.draftConversation) — the press is about
// the caret and the focus, and a second empty draft has nothing to be. Every window converges on the same tab
// either way: a receiving window holding its own untouched draft has it swept by the same write that seats the
// summoned one.
//
// `prompt` is the same action with its first turn already written — what a surface holding a composed task
// presses (the codebase-health panel's per-row refactor). It goes through `enqueue`, so it is an ORDINARY user
// message: it sits in the transcript to be read and argued with, the caret is already in the composer to steer
// it, and Stop works on it like anything else. Not awaited — enqueue's promise settles when the TURN does, and
// the turn reports itself in the transcript (the same reason askAgentToResolve voids it). Enqueued HERE only,
// never through the summons: an act happens once, in the window that was pressed, and reaches the other
// windows as the daemon-side turn it becomes.
//
// Templates must therefore write `@click="startAgent()"`, not `@click="startAgent"`: Vue hands a bare handler
// reference the MouseEvent, which would arrive here as the prompt and be sent to the agent as its first turn.
// `actsAs` pins the fresh chat to a persona before anyone types into it — what the persona rail's rows press
// (ChatPersonaRail). It rides THIS action rather than the rail setting `actsAs` on a draft it summoned itself,
// for the reason the note above gives: a surface that assembles its own half of "new agent" is a surface that
// will one day skip one of the three steps. Undefined is "anyone", which is also a real thing to press.
// Returns the conversation it summoned, so a caller that has to keep pointing at the new chat (the persona
// rail rings the one it opened) does not have to guess which one that was.
export const startAgent = (prompt?: string, actsAs?: string): string => {
    // This workspace has now been delegated to, which is what the desktop's first landing waits for: from here
    // on, opening the app lands on the workspace rather than the board (firstRun.ts). Recorded on the press
    // rather than on the turn completing — the user has seen what the board is for either way.
    markAgentStarted(useSandbox().activeSandboxId.value);
    const conversation = draftConversation();
    // Before the summons, so every window that receives this tab receives it already pinned.
    conversation.actsAs.value = actsAs;
    summonChat({ kind: `reveal`, verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: true });
    revealConversation(conversation);
    if (prompt !== undefined) {
        void conversation.enqueue(prompt);
    }
    return conversation.conversationId;
};

/* THE SAME PRESS WITH THE TURN WRITTEN BUT NOT SENT — what a surface offering a SUGGESTION does (the empty
 * board's starters). Every step of `startAgent` except the send, and that difference is the whole point: the
 * suggestions are not all complete sentences ("bring in my code" stops where the repository goes), and one that
 * sometimes dispatched an agent and sometimes didn't would be a control nobody can predict. Leaving the text in
 * the composer is also what makes it editable, which is the point of suggesting rather than doing.
 *
 * Nothing is marked started, because nothing has been delegated: the first-run screen stays up until a turn is
 * actually sent, which is the fact it exists to track (firstRun.ts).
 *
 * The composer it writes into is the focused chat when nothing has been sent there yet, so trying a second
 * suggestion REPLACES the first rather than opening a second tab (composingConversation). */
export const composeAgent = (prompt: string): void => {
    const conversation = composingConversation();
    conversation.draft.value = prompt;
    summonChat({ kind: `reveal`, verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: true });
    revealConversation(conversation);
};

// The navigation half of a summons, in the window that was pressed: mobile has no docked panel, so the agent's
// own screen is where the summoned chat shows. Local on purpose — a background window navigating itself is a
// route yanked out from under whoever returns to it. Shared with the suggested-session box
// (sessionSuggestion.ts), which must land exactly where "New agent" does once accepted, or the two doors into
// a fresh session open onto two different rooms.
export const revealConversation = (conversation: Conversation): void => {
    if (useDevice().mobile.value) {
        void router.push(`/agents/${encodeURIComponent(conversation.conversationId)}`);
    }
};

// Land: merge the agent's worktree branches into the main tree. A partial result reports per-repo conflicts —
// the worktree keeps everything, so the user can resolve (main-side), discard, or keep working.
// `check` (the default) applies the delta only if ALL of it applies, so a refusal leaves the workspace
// byte-identical. `merge` is what the conflict report offers once the user has read it: a three-way apply that
// lands every clean path and leaves the rest carrying conflict markers to finish in place.
//
// The content-type is NOT optional. Without it `fetch` labels a string body `text/plain`, and the daemon's oRPC
// handler then parses the body as a STRING rather than an object — at which point its compact-input codec
// returns that string as the whole input and drops the `{id}` it took from the path, so every land was refused
// as "Input validation failed" before it reached the handler. Silent for a long time because the land that
// matters most is the automatic one at turn completion, which runs inside the daemon and never crosses this
// seam; what broke was the two manual paths (the review panel's Land/Merge, and dropping a card on Finished) —
// and with them the only way an errored or conflicted agent could ever reach the Finished lane.
//
// `span` picks the rung the patch is measured from, and `cumulative` exists for exactly one case: work this
// agent landed that the user has since discarded from the workspace. Every sha still says it landed — because
// it did — so the default `outstanding` span is empty and would carry nothing at all; only a reading from the
// branch's base can still see what is gone. Paths the tree already holds drop out of it per file, so a
// cumulative land applies the missing part and re-applies nothing (AgentSpanSchema).
//
// `force` is the user overriding the turn guard: land while the agent is mid-write, half-finished work and
// all. It is never a default and never inferred — the daemon lets a PARKED turn (a question, a permission
// card) land without it, so the flag reaches the wire only from a press that showed the warning first.
export const landAgent = (id: string, mode: LandMode = `check`, span: AgentSpan = `outstanding`, force = false): Promise<LandResult> =>
    sandboxJson<LandResult>(`/agents/${encodeURIComponent(id)}/land`, jsonBody(`POST`, { mode, span, force }));

// A collaborator's stand-in for the land they may not perform (the daemon floors `land` at maintainer): stamp
// the ask on the agent so every maintainer's board wears it. The daemon's roster frame carries the result —
// same delivery as every other card fact.
export const requestLandAgent = (id: string): Promise<AgentSummary> =>
    sandboxJson<AgentSummary>(`/agents/${encodeURIComponent(id)}/request-land`, jsonBody(`POST`, {}));

/* THE MAIN ROAD OUT OF A LAND CONFLICT: hand it back to the agent that wrote the work.
 *
 * Everything the other two options cost the user, this one doesn't. `merge` writes conflict markers into THEIR
 * checkout and makes them finish the merge by hand; discard throws the work away. The agent can do the same
 * merge in its own worktree, where a bad resolution costs nobody anything — and land's anchorOf already
 * re-anchors on the merge-base precisely so a rebased branch still lands exactly its own delta.
 *
 * It is an ordinary turn, not a new endpoint, and that is the point: the composed prompt lands in the
 * transcript as a user message the human can read and argue with, a turn already running takes it as steering,
 * and Stop works on it like any other. The loop then closes itself — a clean turn auto-lands (streamAgent),
 * and recordLanded clears the entry's conflicts, so the report this was raised from disappears on its own.
 *
 * The tab is opened, not assumed: the board's drop fires this for a card whose conversation this browser may
 * never have opened. `open` also marks it seen, which is right — the user is dealing with it.
 *
 * The report is re-read here rather than passed in, even though the review panel is holding one: the prompt is
 * a description of a CURRENT refusal, and the two callers know it to different degrees of freshness (the
 * board holds none at all). One cheap GET makes both of them right, and makes the daemon the only thing that
 * ever decides what the agent is told to fix. */

/* Whether the turn actually went, and — when it didn't — the one sentence to say so. Two of the three answers
 * here are refusals, and both of them used to be silent `return`s: the caller got a resolved promise and drew
 * a card that was on its way to being fixed by nobody. The wording lives with the decision rather than at each
 * call site, so the board's notice strip and the review panel's error line can't come to explain the same
 * refusal two different ways. */
export type ResolveAsk = { readonly sent: true } | { readonly sent: false; readonly why: string };

export const askAgentToResolve = async (id: string): Promise<ResolveAsk> => {
    const { agentById, open } = useAgents();
    const agent = agentById(id);
    if (agent !== undefined) {
        open(agent);
    }
    const conversation = useChat().conversations.value.find((candidate) => candidate.conversationId === id);
    // A registered agent always has a tab by now (open() just made one); a card the roster has never heard of
    // has no conversation to send to, and inventing one would start a turn on the wrong agent.
    if (conversation === undefined) {
        return { sent: false, why: `That agent has no conversation left to send to.` };
    }
    const { conflicts } = await sandboxJson<AgentChangesResponse>(`/agents/${encodeURIComponent(id)}/diff`);
    /* NOTHING FOR THE AGENT TO DO IS A REFUSAL, NOT A SEND — and the only guard that can be trusted, because it
     * is made against a report the daemon RE-DERIVES at read time (land.ts outstandingConflicts): fetched
     * fresh and classified fresh. A fresh fetch alone was not enough — the stored refusal's `workspace` rows
     * outlive the uncommitted edits they name, and this guard kept refusing "commit or stash them" over a
     * tree the user had long since committed.
     *
     * The review panel arrives here having already read the report and hidden its button when `mine` is empty
     * (AgentConflictReport). The board cannot: the roster carries `status: "conflict"` and no blockers, so a
     * card is armed on the fact of a refusal without knowing whose refusal it is. Both surfaces therefore ask
     * the same question in the same place, once the report is in hand.
     *
     * Left ungated, a conflict held ENTIRELY by the user's own uncommitted edits sent the agent a prompt whose
     * "What blocked the land:" section was empty — a turn spent telling it to rebase away nothing, ending in a
     * land that refuses identically. The user's own half is the one thing a rebase provably cannot reach
     * (conflictResolution.ts), so it is named here instead, in the terms of the fix that does work. */
    const blockers = blockersOf(conflicts);
    if (agentBlockers(blockers).length === 0) {
        const yours = userBlockers(blockers).length;
        return {
            sent: false,
            why:
                yours > 0
                    ? `A rebase can't reach this: ${yours === 1 ? `the blocked file is` : `all ${yours} blocked files are`} held by your own uncommitted edits. Commit or stash them, then land again.`
                    : `Nothing left for the agent to rebase — open it to see what the land reported.`,
        };
    }
    // Dispatched, not awaited — `enqueue` runs the queue, and drainQueue awaits `send`, which does not settle
    // until the TURN does. Awaiting it here would hold the caller's busy flag across a multi-minute rebase and
    // set the panel's "resolving" state only once there was nothing left to resolve. `void` is what every
    // other send in this app does (ChatPanel): the turn reports itself in the transcript, which is where its
    // failures belong too — this function's own promise is about getting the message away.
    void conversation.enqueue(resolvePrompt(conflicts));
    return { sent: true };
};

// Discard: drop the worktrees, the agent/<id> branches, and the registry entry. Irreversible.
export const discardAgent = async (id: string): Promise<void> => {
    await sandboxJson(`/agents/${encodeURIComponent(id)}/discard`, { method: `POST` });
};

// True cancel for an in-flight turn. An open, streaming tab owns the local transcript, so its own stop() runs
// the whole path (muted "Stopped." notice → /agent/stop → abort the stream); a card whose conversation this
// browser never opened has no tab to speak for it, so post the cancel straight to the daemon.
export const stopAgent = async (id: string): Promise<void> => {
    const { conversations } = useChat();
    const conversation = conversations.value.find((candidate) => candidate.conversationId === id);
    if (conversation !== undefined && conversation.streaming.value) {
        conversation.stop();
        return;
    }
    await sandboxJson(`/agent/stop`, jsonBody(`POST`, { conversationId: id }));
};

// After a land or discard the agent's diff changed AND the landed work now shows in the MAIN review +
// history — invalidate all three so every surface converges. Three disjoint caches, no ordering.
export const invalidateAgentAction = async (id: string): Promise<void> => {
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: AGENTS.of(id, `diff`) }),
        queryClient.invalidateQueries({ queryKey: GIT_CHANGES.every }),
        queryClient.invalidateQueries({ queryKey: HISTORY_SNAPSHOTS.every }),
    ]);
};
