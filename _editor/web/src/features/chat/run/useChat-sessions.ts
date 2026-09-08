import type { MatchSnippet, TranscriptRow } from "@intentic/sandbox-contract";
import { ref, watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { agentTranscript, type AgentTranscript } from "../transcript/agentTranscript";
import type { Conversation } from "../session/conversation";
import type { PickUp } from "./pickUp";
import { activeId, conversations, setConversations } from "../tabs/useChat-tabs";
import { sandboxRequest, sandboxRequestVia } from "../../sandbox/client/sandboxClient";
import { useSandbox } from "../../sandbox/client/useSandbox";

// One past conversation in the sandbox's SDK session store, for the history menu.
export interface ChatSession {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
    // Why a search matched: the hit line and which side said it; absent unfiltered or on a title match.
    readonly snippet?: MatchSnippet;
}

const { reachable } = useSandbox();

// Past conversations from the sandbox's session store, loaded on demand for the history menu.
export const sessions = ref<ChatSession[]>([]);

// Refreshes the history list from the session store; a query filters by title or content server-side. Each
// call aborts the one before it, so a burst of keystroke-driven searches can't land out of order.
let sessionsLoad: AbortController | undefined;
export const loadSessions = async (query?: string): Promise<void> => {
    sessionsLoad?.abort();
    const controller = new AbortController();
    sessionsLoad = controller;
    try {
        const response = await sandboxRequest(query ? `/sessions?query=${encodeURIComponent(query)}` : `/sessions`, { signal: controller.signal });
        if (!response.ok) {
            return;
        }
        const body = (await response.json()) as { sessions?: ChatSession[] };
        sessions.value = body.sessions ?? [];
    } catch {
        // Non-fatal (including our own abort); the menu shows whatever was loaded last.
    }
};

// Reads a session's transcript from the daemon's store (history menu and restore rehydration). Undefined
// means the daemon had nothing; asks the conversation's own box, since a session lives on the runtime that minted it.
export const fetchTranscript = async (conversation: Conversation, id: string): Promise<TranscriptRow[] | undefined> => {
    try {
        const response = await sandboxRequestVia(conversation.box.value, `/sessions/${encodeURIComponent(id)}`);
        if (!response.ok) {
            conversation.error.value = `Could not open that conversation.`;
            return undefined;
        }
        const body = (await response.json()) as { messages?: TranscriptRow[] };
        return body.messages ?? [];
    } catch {
        conversation.error.value = `Could not open that conversation.`;
        return undefined;
    }
};

// Cached transcript read shared across a card being warmed and one just opened, archived agents included. A
// failure surfaces on the conversation and returns undefined so the caller retries; `gone` passes through.
const fetchAgentTranscript = async (conversation: Conversation): Promise<AgentTranscript | undefined> => {
    try {
        return await agentTranscript(conversation.conversationId, conversation.box.value);
    } catch {
        conversation.error.value = `Could not open that conversation.`;
        return undefined;
    }
};

// Brings a tab with no visible transcript up to date: attaches to a running turn, or replays the stored
// session. False means the round-trip failed; the caller retries on the next reachability flip.
const hydrate = async (conversation: Conversation): Promise<boolean> => {
    // Must run before attaching, or the live turn paints over an empty transcript and clobbers the mirror.
    await conversation.paintCached();
    // Whether anything is there already, not whether this call put it there (the sweep may have painted it).
    const seeded = conversation.messages.value.length === 0;
    // Only case with nothing to show meanwhile: report loading rather than inviting a fresh start.
    conversation.loading.value = seeded;
    try {
        // A failed seed still lets the attach run; the failure rides the return value so the caller retries.
        const seededOk = seeded ? await replayStoredSession(conversation) : true;
        if (await conversation.reattach()) {
            return seededOk;
        }
        // With nothing running, reconcile the mirror against the daemon unless seeding just did.
        return seeded ? seededOk : await replayStoredSession(conversation);
    } finally {
        conversation.loading.value = false;
    }
};

// Redraws a conversation from the daemon's own record, the only copy surviving a device with no mirror. False
// means the read failed, not that there's nothing to show. Asked for every provider now.
const replayStoredSession = async (conversation: Conversation): Promise<boolean> => {
    // Fleet conversations resolve by identity, not session id; adopt whatever session supplied it.
    let restored: TranscriptRow[] | undefined;
    // Position of these rows in the daemon's record; absent for the SDK-session fallback, which has none.
    let page: { readonly from: number; readonly more: boolean } | undefined;
    // How the last turn ended; applied once the transcript below is in place (see Conversation.adoptEnding).
    let ending: PickUp | undefined;
    if (conversation.registered.value) {
        const transcript = await fetchAgentTranscript(conversation);
        if (transcript === undefined) {
            return false;
        }
        if (transcript === `gone`) {
            // A named 404 means the daemon dropped this id; an archive or lost stream don't. Unlatched, it's an
            // ordinary draft: empty, the sweep takes it; with a transcript, it stays open and re-registers on send.
            conversation.registered.value = false;
            setConversations(conversations.value, activeId.value, `unlatch-registered`);
        } else {
            restored = transcript.messages;
            page = { from: transcript.from, more: transcript.more };
            ending = transcript.ending;
            // Session as the daemon actually has it; the tab's own picks would drift the moment
            // account/provider/harness switches mid-chat. No session in the record leaves the tab's existing ref alone.
            if (transcript.session !== undefined) {
                conversation.bindSession(transcript.session);
            }
        }
    }
    // Not an else: a tab that lost its agent may still have an SDK session readable in that separate store.
    if (restored === undefined) {
        const session = conversation.session.value;
        if (session === undefined) {
            return true;
        }
        restored = await fetchTranscript(conversation, session.id);
        if (restored === undefined) {
            return false;
        }
    }
    // A record read can only delete a live turn: the daemon writes it on settle, so a redraw skips while
    // streaming. An empty replay is absence, not a transcript, and must not blank an already-painted or cached one.
    if (restored.length > 0 && !conversation.streaming.value) {
        conversation.restoreMessages(restored, page);
    }
    // Applied last, over a painted transcript rather than the blank interim pane. Handed the verdict, not gated
    // on it: adoptEnding itself refuses a live turn, an empty transcript, or an already-armed pick-up.
    conversation.adoptEnding(ending);
    return true;
};

// In-flight guard only; unlike `hydrating` (done for good), this clears once the pass ends either way.
const hydrateInFlight = new WeakSet<Conversation>();

// Hydrates a tab once, holding the in-flight mark while the daemon answers. Exported for the pane's fleet
// watcher, which calls it whenever the fleet reports a change to a conversation this tab didn't stream itself.
export const hydrateOnce = (conversation: Conversation): void => {
    if (hydrateInFlight.has(conversation)) {
        return;
    }
    hydrateInFlight.add(conversation);
    hydrating.add(conversation);
    void hydrate(conversation)
        .then((current) => {
            if (!current) {
                hydrating.delete(conversation);
            }
        })
        // Unreachable daemon leaves the tab as-is; caught so it doesn't surface as an unhandled rejection.
        .catch(() => hydrating.delete(conversation))
        .finally(() => hydrateInFlight.delete(conversation));
};

// Tabs already hydrated (attach-first, then session fallback); done, not in-flight (see hydrateInFlight).
const hydrating = new WeakSet<Conversation>();
// Cached-transcript tabs, not daemon-confirmed; they still hydrate, so the guard below isn't fooled.
const painted = new WeakSet<Conversation>();

// Paints every restored tab from the local mirror immediately, without waiting on reachability: a reopened
// chat is readable before any round-trip (see transcriptCache).
export const paintCachedTranscripts = (list: readonly Conversation[]): void => {
    for (const conversation of list) {
        void conversation.paintCached().then((didPaint) => {
            if (didPaint) {
                painted.add(conversation);
            }
        });
    }
};
paintCachedTranscripts(conversations.value);

watch([reachable, conversations], ([isReachable]) => {
    if (!isReachable) {
        return;
    }
    for (const conversation of conversations.value) {
        if ((conversation.messages.value.length > 0 && !painted.has(conversation)) || conversation.streaming.value || hydrating.has(conversation)) {
            continue;
        }
        hydrateOnce(conversation);
    }
});

// Attaches a tab to a turn this browser didn't start (e.g. a workflow step whose turn begins before the tab
// hydrates). Driven by the roster stream; touches only a tab with nothing painted yet.
export const attachStarted = (ids: ReadonlySet<string>): void => {
    for (const conversation of conversations.value) {
        if (!ids.has(conversation.conversationId) || conversation.streaming.value || conversation.messages.value.length > 0) {
            continue;
        }
        hydrateOnce(conversation);
    }
};

// Singleton per window: a hot update re-running this module would mint a second hydration ledger beside the
// one still in use.
reloadOnHotUpdate(import.meta);
