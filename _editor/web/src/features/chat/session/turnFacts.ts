import type { TranscriptPatch, TurnFact } from "@intentic/sandbox-contract";
import { importOrReload } from "../../../router/staleChunk";
import { setAccountUsage } from "../accounts/providerAccounts";
import { boundSession } from "../run/turnRequest";
import type { AttachEntry, TurnContext } from "../run/turnStream";
import type { Conversation } from "./conversation";

// What a run's entries mean to the conversation beyond its rows, which the transcript has already drawn: the session
// the turn minted, the worktree it runs in, its live posture and model, the terminal and browser it drives, and how it
// failed. Every fact is a state statement, not an increment, so a replayed one applies again harmlessly.

// Chats already told the sandbox can't isolate their turns; said once per chat, ever.
const warnedUnenforced = new WeakSet<Conversation>();

// A tool card arriving for the first time: a main-tree turn records its written paths for the Changes panel to warn
// against, per repo; an isolated turn records nothing, since its writes land in its own worktree diff.
const applyPatchConsequence = (conversation: Conversation, patch: TranscriptPatch): void => {
    if (patch.op !== `tool` || !conversation.turn.firstSight(patch.tool.id)) {
        return;
    }
    const startedAt = conversation.turn.turnStartedAt.value;
    if (!conversation.isolated.value && startedAt !== undefined) {
        const call = patch.tool;
        importOrReload(
            () => import(`../../workspace/files/liveWrites`),
            (m) => m.recordTurnWrite(conversation.conversationId, startedAt, call),
        );
    }
};

// The agent started a watchable resource (its tmux terminal, its browser): named after the chat, and surfaced.
const surfaceSession = (conversation: Conversation, session: string): void => {
    const title = conversation.title.value;
    importOrReload(
        () => import("../../terminal/useWorkTerminals"),
        (m) => m.noteAgentTerminal(session, title),
    );
    importOrReload(
        () => import("../../terminal/useTerminalPanel"),
        (m) => m.useTerminalPanel().surface(session),
    );
};

// Each fact kind's consequence, one entry per kind of the contract's union, so a kind added there is a compile error
// here until it is given one.
const FACTS: { readonly [K in TurnFact["kind"]]: (conversation: Conversation, fact: Extract<TurnFact, { kind: K }>, turn: TurnContext) => void } = {
    // Account comes off the fact when the daemon named one, else falls back to what this turn asked for. A session other
    // than the one held is a new segment, whoever decided it (the daemon's routing): the terminal and browser the old one
    // drove are not this one's.
    session: (conversation, fact, turn) => {
        if (conversation.session.value !== undefined && conversation.session.value.id !== fact.sessionId) {
            conversation.agentTerminal.value = undefined;
            conversation.agentBrowser.value = undefined;
        }
        conversation.selection.apply({ kind: `bindSession`, session: boundSession(fact.sessionId, turn, fact.account) });
    },
    // First fact of an isolated turn: which branch/base this conversation works on. The sandbox can't enforce the
    // worktree with mounts, so tool paths redirect instead; said once, ever.
    worktree: (conversation, fact) => {
        conversation.worktree.value = { branch: fact.branch, base: fact.base };
        if (fact.unenforced === true && !warnedUnenforced.has(conversation)) {
            warnedUnenforced.add(conversation);
            conversation.transcript.notice(
                `This sandbox can't isolate agent turns at the filesystem level (it was created without CAP_SYS_ADMIN). Work is redirected into ${fact.branch}, but a command that builds its own paths can still reach the shared workspace: recreate the sandbox to restore full isolation.`,
            );
        }
    },
    // The turn's live posture, echoed back or moved by the agent; drives the selector, not the pick.
    mode: (conversation, fact) => {
        conversation.turn.liveMode.value = fact.mode;
    },
    // The provider's slash commands (ACP agents), replaced whole, for the composer's `/` popover.
    commands: (conversation, fact) => {
        conversation.availableCommands.value = fact.items;
    },
    init: (conversation, fact) => {
        conversation.activeModel.value = fact.model;
    },
    // Per-conversation context-window fill, held here so the composer shows the active chat's own meter.
    context_usage: (conversation, fact) => {
        conversation.contextUsage.value = { tokens: fact.tokens, contextWindow: fact.contextWindow };
    },
    // The turn's cost lives on the bubble it ended in; nothing to keep here.
    usage: () => undefined,
    // Account-wide headroom, keyed by the serving account and stamped with read time so newest-wins.
    account_usage: (conversation, fact) => {
        if (fact.account !== undefined) {
            setAccountUsage(conversation.selection.provider.value, fact.account, { windows: [...fact.windows], measuredAt: Date.now() });
        }
    },
    // The agent started running Bash in its tmux terminal; remembered so Bash cards can offer to watch it.
    terminal: (conversation, fact) => {
        conversation.agentTerminal.value = fact.session;
        surfaceSession(conversation, fact.session);
    },
    // The agent just used a browser tool; handled like the terminal above, an equally watchable resource.
    browser: (conversation, fact) => {
        conversation.agentBrowser.value = fact.session;
        surfaceSession(conversation, fact.session);
    },
    // A wait, not a failure: the turn is still running. Held only while it is (TurnClient's settle).
    provider_retry: (conversation, fact) => {
        conversation.turn.providerRetry.value = fact;
    },
    // Not cleared at the turn boundary: the answer outlives the turn that reported it.
    fast_mode: (conversation, fact) => {
        conversation.fastMode.value = fact;
    },
    error: (conversation, fact) => conversation.failures.apply(fact),
    // The live gate, not a headroom reading: `account_usage` carries every pool for the readouts.
    rate_limit_info: () => undefined,
};

const applyFact = <K extends TurnFact["kind"]>(conversation: Conversation, fact: Extract<TurnFact, { kind: K }>, turn: TurnContext): void =>
    (FACTS[fact.kind as K] as (conversation: Conversation, fact: Extract<TurnFact, { kind: K }>, turn: TurnContext) => void)(
        conversation,
        fact,
        turn,
    );

// One entry's consequences beyond its rows, in arrival order: `providerRetry` clears on anything, sets on its fact.
export const applyTurnEntry = (conversation: Conversation, entry: AttachEntry, turn: TurnContext): void => {
    // Any other entry means the wait a provider_retry described is over, whatever happens next.
    if (entry.kind !== `fact` || entry.fact.kind !== `provider_retry`) {
        conversation.turn.providerRetry.value = undefined;
    }
    if (entry.kind === `patch`) {
        applyPatchConsequence(conversation, entry.patch);
        return;
    }
    applyFact(conversation, entry.fact, turn);
};
