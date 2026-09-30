import { type Backoff, createBackoff } from "@intentic/base/async";
import type { MatchSnippet, TranscriptRow } from "@intentic/sandbox-contract";
import { sandboxRef, sandboxValue } from "@intentic/extension-api";
import { errorMessage } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { useDevice } from "@intentic/ui";
import { watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { whenIdle } from "../../../lib/whenIdle";
import { agentTranscript, type AgentTranscript, freshAgentTranscript } from "../transcript/agentTranscript";
import type { Conversation } from "../session/conversation";
import type { PickUp } from "./pickUp";
import { activeId, conversations, scopedSandboxId, setConversations } from "../tabs/useChat-tabs";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
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
export const sessions = sandboxRef<ChatSession[]>(() => []);
// Why the last history read failed; the menu says it instead of "no previous chats" over a list it never got.
export const sessionsFailure = sandboxRef<string | undefined>(() => undefined);

// Refreshes the history list from the session store; a query filters by title or content server-side. Each
// call aborts the one before it, so a burst of keystroke-driven searches can't land out of order, and so does a
// switch, whose history is another store's.
const sessionsLoad = sandboxValue<AbortController | undefined>(
    () => undefined,
    (load) => load?.abort(),
);
export const loadSessions = async (query?: string): Promise<void> => {
    sessionsLoad.value?.abort();
    const controller = new AbortController();
    sessionsLoad.value = controller;
    try {
        sessions.value = (await sandboxRpc.sessions.list(query ? { query } : {}, { signal: controller.signal })).sessions;
        sessionsFailure.value = undefined;
    } catch (error) {
        // Our own abort means a newer read owns the menu; anything else is this read's failure to say.
        if (!controller.signal.aborted) {
            sessionsFailure.value = errorMessage(error, `Couldn't read your past chats.`);
        }
    }
};

// A session's transcript from the daemon's store; asks the conversation's own box, since a session lives on the runtime
// that minted it.
const readSession = async (conversation: Conversation, id: string): Promise<TranscriptRow[]> =>
    (await sandboxRpc.sessions.get({ id }, { context: { at: conversation.box.value } })).messages;

// What a read that did not answer says of itself when it says nothing (errorMessage's fallback).
const noAnswer = (): string => t(`chat.chatSessions.noAnswer`);

// Reads a session's transcript for the history menu, into a tab with nothing painted. Undefined means the read failed,
// which the error line says with the read's own reason.
export const fetchTranscript = async (conversation: Conversation, id: string): Promise<TranscriptRow[] | undefined> => {
    try {
        return await readSession(conversation, id);
    } catch (error) {
        conversation.error.value = `${t(`chat.chatPaneTurns.couldntOpen`)} ${errorMessage(error, noAnswer())}`;
        return undefined;
    }
};

// A hydrating read that did not answer: said beside the transcript (TranscriptView.refresh), never as the error line,
// which put "Could not open that conversation." in red under a transcript already painted. `reason` is the read's own
// words, when it had any. Undefined, for the caller.
const readFailed = (conversation: Conversation, reason?: string): undefined => {
    conversation.transcript.refresh.value = reason === undefined ? { kind: `failed` } : { kind: `failed`, reason };
    return undefined;
};

// Tabs whose next transcript read skips the cache, which would hand back the read that hung (retryHydrate).
const askFresh = new WeakSet<Conversation>();

// Cached transcript read shared across a card being warmed and one just opened, archived agents included. A
// failure surfaces on the conversation and returns undefined so the caller retries; `gone` passes through. Only the
// tab's newest pass (`current`) may say it failed: a read a retry replaced while it hung would otherwise mark a
// transcript the newer one already painted as unreadable, and nothing would clear it.
const fetchAgentTranscript = async (conversation: Conversation, current: () => boolean): Promise<AgentTranscript | undefined> => {
    const fresh = askFresh.has(conversation);
    askFresh.delete(conversation);
    try {
        return await (fresh ? freshAgentTranscript : agentTranscript)(conversation.conversationId, conversation.box.value);
    } catch (error) {
        return current() ? readFailed(conversation, errorMessage(error, noAnswer())) : undefined;
    }
};

// Brings a tab with no visible transcript up to date: attaches to a running turn, or replays the stored
// session. False means the round-trip failed; the caller retries (retryLater). `current` says whether this pass is still
// the tab's newest, the only one whose ending may move its loading mark.
const hydrate = async (conversation: Conversation, current: () => boolean): Promise<boolean> => {
    // Must run before attaching, or the live turn paints over an empty transcript and clobbers the mirror.
    await conversation.transcript.paintCached();
    // A draft the daemon never filed has no record or run to read; the roster registering it re-hydrates (paneAttach).
    if (!conversation.registered.value && conversation.session.value === undefined) {
        return true;
    }
    // Whether anything is there already, not whether this call put it there (the sweep may have painted it).
    const seeded = conversation.transcript.messages.value.length === 0;
    // Only case with nothing to show meanwhile: report loading rather than inviting a fresh start.
    conversation.transcript.loading.value = seeded;
    let hydrated = false;
    try {
        // A failed seed still lets the attach run; the failure rides the return value so the caller retries.
        const seededOk = seeded ? await replayStoredSession(conversation, current) : true;
        const live = await conversation.turn.reattach();
        if (live === undefined) {
            // The daemon was never asked whether a turn runs, so this is not hydrated whatever the record said: a first
            // turn still running has no record yet, and reading this as "nothing running" drew an empty chat over it.
            if (current() && conversation.transcript.refresh.value?.kind !== `failed`) {
                readFailed(conversation);
            }
            return false;
        }
        // With nothing running, reconcile the mirror against the daemon unless seeding just did.
        hydrated = live || seeded ? seededOk : await replayStoredSession(conversation, current);
        return hydrated;
    } finally {
        // Nothing painted and another try on its way is still loading, not the empty invitation to start a chat.
        if (current()) {
            conversation.transcript.loading.value = !hydrated && conversation.transcript.messages.value.length === 0 && retryComing(conversation);
        }
    }
};

// The rows of the tab's own SDK session, read from that separate store: `none` without one, undefined when the read
// failed, which only the tab's newest pass says (fetchAgentTranscript).
const sessionRows = async (conversation: Conversation, current: () => boolean): Promise<TranscriptRow[] | `none` | undefined> => {
    const session = conversation.session.value;
    if (session === undefined) {
        return `none`;
    }
    try {
        return await readSession(conversation, session.id);
    } catch (error) {
        return current() ? readFailed(conversation, errorMessage(error, noAnswer())) : undefined;
    }
};

// Redraws a conversation from the daemon's own record, the only copy surviving a device with no mirror. False
// means the read failed, not that there's nothing to show. Asked for every provider now. A pass no longer the tab's
// newest (`current`) never says the read failed; any answer still paints, since the sandbox answered.
const replayStoredSession = async (conversation: Conversation, current: () => boolean): Promise<boolean> => {
    // Fleet conversations resolve by identity, not session id; adopt whatever session supplied it.
    let restored: TranscriptRow[] | undefined;
    // Position of these rows in the daemon's record; absent for the SDK-session fallback, which has none.
    let page: { readonly from: number; readonly more: boolean } | undefined;
    // How the last turn ended; applied once the transcript below is in place (see TurnFailures.adoptEnding).
    let ending: PickUp | undefined;
    if (conversation.registered.value) {
        const transcript = await fetchAgentTranscript(conversation, current);
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
                conversation.selection.apply({ kind: `bindSession`, session: transcript.session });
            }
        }
    }
    // Not an else: a tab that lost its agent may still have an SDK session readable in that separate store.
    if (restored === undefined) {
        const fallback = await sessionRows(conversation, current);
        if (fallback === `none`) {
            return true;
        }
        if (fallback === undefined) {
            return false;
        }
        restored = fallback;
    }
    // The sandbox answered: whatever an earlier read left said beside the transcript no longer holds.
    conversation.transcript.refresh.value = undefined;
    // A record read can only delete a live turn: the daemon writes it on settle, so a redraw skips while
    // streaming. An empty replay is absence, not a transcript, and must not blank an already-painted or cached one.
    if (restored.length > 0 && !conversation.turn.streaming.value) {
        conversation.transcript.restoreMessages(restored, page);
    }
    // Applied last, over a painted transcript rather than the blank interim pane. Handed the verdict, not gated
    // on it: adoptEnding itself refuses a live turn, an empty transcript, or an already-armed pick-up.
    conversation.failures.adoptEnding(ending);
    return true;
};

// The pass in flight, cleared once it ends either way (unlike `hydrating`, done for good), so it can be waited on.
const hydrateInFlight = new WeakMap<Conversation, Promise<void>>();

// Each tab's newest pass, by number: a retry may replace a pass while it hangs, and only the newest speaks for the tab.
const passes = new WeakMap<Conversation, number>();

// Hydrates a tab once, holding the in-flight mark while the daemon answers. Exported for the pane's fleet
// watcher, which calls it whenever the fleet reports a change to a conversation this tab didn't stream itself.
export const hydrateOnce = (conversation: Conversation): void => {
    if (hydrateInFlight.has(conversation)) {
        return;
    }
    hydrating.add(conversation);
    const mine = (passes.get(conversation) ?? 0) + 1;
    passes.set(conversation, mine);
    const current = (): boolean => passes.get(conversation) === mine;
    const pass = (async (): Promise<void> => {
        let hydrated = false;
        try {
            hydrated = await hydrate(conversation, current);
        } catch (error) {
            // Logged, since a tab that never fills says nothing; the pane says the read failed rather than going blank.
            console.warn(`hydrateOnce: ${conversation.conversationId} did not hydrate`, error);
            if (current()) {
                readFailed(conversation, errorMessage(error, noAnswer()));
            }
        }
        if (!current()) {
            return;
        }
        if (hydrated) {
            answered(conversation);
            return;
        }
        hydrating.delete(conversation);
        retryLater(conversation);
    })().finally(() => {
        // Only its own mark: a retry may have replaced it with a newer pass while this one hung.
        if (hydrateInFlight.get(conversation) === pass) {
            hydrateInFlight.delete(conversation);
        }
    });
    hydrateInFlight.set(conversation, pass);
};

// A tab's failed passes since the last one that answered, and the retry waiting to run. A failed pass is asked again on a
// climbing wait rather than only on a reachability flip, which never comes when the app thinks the sandbox is reachable
// all along (after a wake, every read on the dead route waited out its deadline while the footer said online).
interface Retrying {
    readonly ladder: Backoff;
    tries: number;
    timer?: ReturnType<typeof setTimeout>;
}
const retrying = new WeakMap<Conversation, Retrying>();
// About a minute and a half of asking (2 s, doubling to 30 s), after which the pane's Retry is the reader's to press.
const RETRY_TRIES = 6;

// Whether a failed pass is asked again by itself: online (offline, the reachability flip asks) and tries left.
const retryComing = (conversation: Conversation): boolean => reachable.value && (retrying.get(conversation)?.tries ?? 0) < RETRY_TRIES;

const retryLater = (conversation: Conversation): void => {
    if (!retryComing(conversation)) {
        return;
    }
    const entry = retrying.get(conversation) ?? { ladder: createBackoff({ floorMs: 2_000, capMs: 30_000 }), tries: 0 };
    retrying.set(conversation, entry);
    entry.tries += 1;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
        // A tab since closed, or one a stream or another pass already took, is left alone.
        if (conversations.value.includes(conversation) && !conversation.turn.streaming.value && !hydrating.has(conversation)) {
            hydrateOnce(conversation);
        }
    }, entry.ladder.next());
};

// A pass that answered: the ladder starts over, and nothing is left to say beside the transcript.
const answered = (conversation: Conversation): void => {
    clearTimeout(retrying.get(conversation)?.timer);
    retrying.delete(conversation);
    conversation.transcript.refresh.value = undefined;
};

// The reader's Retry on a transcript that has been loading far too long: a new pass even while the old one still hangs
// (a read stuck behind a queue of slow requests answers nothing, so waiting on it is what left "still fetching" up for
// minutes). The old pass is left to finish or fail on its own; whichever answers paints. A press starts the ladder over.
export const retryHydrate = (conversation: Conversation): void => {
    clearTimeout(retrying.get(conversation)?.timer);
    retrying.delete(conversation);
    askFresh.add(conversation);
    hydrateInFlight.delete(conversation);
    hydrateOnce(conversation);
};

// A shown chat after the page slept a long while: what it shows may be minutes old and the reads queued before the
// sleep may never answer, so it is asked again past the cache, saying "Reconnecting…" over what is painted until the
// sandbox answers. A live stream is its own freshest copy, and recovers by itself.
export const refreshAfterSleep = (conversation: Conversation): void => {
    if (conversation.turn.streaming.value) {
        return;
    }
    conversation.transcript.refresh.value = { kind: `reconnecting` };
    retryHydrate(conversation);
};

// Resolves once a tab shows what it holds, painted or hydrated with nothing to paint: a turn opened sooner sits on a
// blank transcript the daemon's record won't redraw, since a redraw refuses a live turn (replayStoredSession).
export const transcriptShown = (conversation: Conversation): Promise<void> => {
    const pass = hydrateInFlight.get(conversation);
    if (pass === undefined || conversation.transcript.messages.value.length > 0) {
        return Promise.resolve();
    }
    return new Promise((shown) => {
        const painted = watch(
            () => conversation.transcript.messages.value.length > 0,
            (drawn) => {
                if (drawn) {
                    painted();
                    shown();
                }
            },
        );
        void pass.finally(() => {
            painted();
            shown();
        });
    });
};

// Tabs already hydrated (attach-first, then session fallback); done, not in-flight (see hydrateInFlight).
const hydrating = new WeakSet<Conversation>();
// Cached-transcript tabs, not daemon-confirmed; they still hydrate, so the guard below isn't fooled.
const painted = new WeakSet<Conversation>();

// THE CHAT IN FRONT FIRST, THE REST AT IDLE, on a phone. Every restored tab painted its mirror and fetched its record at
// once — an IndexedDB read, a transcript page of up to 2 MB validated on the main thread, rows built for each — though a
// phone shows one chat at a time: its start paid for every tab the reader had left open. There the tab in front goes
// first and each other follows in an idle moment of its own, so all of them are still ready by the time anyone switches.
const { mobile, coarse } = useDevice();
const inFrontFirst = <T>(each: (conversation: Conversation) => T): void => {
    const front = conversations.value.find((conversation) => conversation.conversationId === activeId.value);
    const rest = conversations.value.filter((conversation) => conversation !== front);
    if (!(mobile.value || coarse.value)) {
        for (const conversation of [...(front === undefined ? [] : [front]), ...rest]) {
            each(conversation);
        }
        return;
    }
    if (front !== undefined) {
        each(front);
    }
    const next = (): void => {
        const conversation = rest.shift();
        if (conversation === undefined) {
            return;
        }
        each(conversation);
        whenIdle(next);
    };
    whenIdle(next);
};

// Paints every restored tab from the local mirror immediately, without waiting on reachability: a reopened
// chat is readable before any round-trip (see transcriptCache). At load, and each time a sandbox's tabs come back.
watch(
    scopedSandboxId,
    () => {
        inFrontFirst((conversation) => {
            void conversation.transcript.paintCached().then((didPaint) => {
                if (didPaint) {
                    painted.add(conversation);
                }
            });
        });
    },
    { immediate: true },
);

watch([reachable, conversations], ([isReachable]) => {
    if (!isReachable) {
        return;
    }
    inFrontFirst((conversation) => {
        if ((conversation.transcript.messages.value.length > 0 && !painted.has(conversation)) || conversation.turn.streaming.value || hydrating.has(conversation)) {
            return;
        }
        hydrateOnce(conversation);
    });
});

// Attaches a tab to a turn this browser didn't start (e.g. a workflow step whose turn begins before the tab
// hydrates). Driven by the roster stream; touches only a tab with nothing painted yet.
export const attachStarted = (ids: ReadonlySet<string>): void => {
    for (const conversation of conversations.value) {
        if (!ids.has(conversation.conversationId) || conversation.turn.streaming.value || conversation.transcript.messages.value.length > 0) {
            continue;
        }
        hydrateOnce(conversation);
    }
};

// Singleton per window: a hot update re-running this module would mint a second hydration ledger beside the
// one still in use.
reloadOnHotUpdate(import.meta);
