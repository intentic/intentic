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
    // Why a searched row matched: the line the query hit, and which side of the chat said it. Absent on an
    // unfiltered list, and on a title match, the row already shows the title, so repeating it is noise.
    readonly snippet?: MatchSnippet;
}

const { reachable } = useSandbox();

// Past conversations from the sandbox's session store, loaded on demand for the history menu.
export const sessions = ref<ChatSession[]>([]);

// Refresh the history list from the sandbox's session store (call when opening the history menu). A query
// filters the list by chat title or content, server-side.
// Each call ABORTS the one before it: a search is fired per settled keystroke, and without the abort a burst
// of queries piles up on the daemon and lands out of order, the slowest, stalest response overwriting the
// list the newest query already painted.
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

// Read a session's transcript from the daemon's session store, for both the history menu and the restored-tab
// rehydration watch. Returns undefined when the daemon has nothing, having reported it on the conversation.
//
// From the CONVERSATION's own box: a provider session is minted by the runtime that ran the turn and stored
// beside it, so a tab homed in another sandbox has to ask that daemon (Conversation.box). Asking the active one
// about a session id it never minted is a 404 dressed up as "could not open that conversation".
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

/* A registered agent's transcript, through the shared cached read (agentTranscript.ts), so a card the
 * background loader already warmed opens without a round trip, and a card clicked WHILE it is being warmed
 * waits for that read instead of starting a second one. Archiving keeps the entry, the registry holds archived
 * agents and `entry(id)` finds them, so an archived agent answers 200 and its tab is never touched by this.
 *
 * What this adds over the cached read is the TAB's half: a failure is reported on the conversation, where the
 * user can see it, and folded to `undefined` so the caller retries rather than settling for an empty pane. The
 * "gone" verdict passes straight through, it is the one answer that says something about this conversation
 * rather than about the network. */
const fetchAgentTranscript = async (conversation: Conversation): Promise<AgentTranscript | undefined> => {
    try {
        return await agentTranscript(conversation.conversationId, conversation.box.value);
    } catch {
        conversation.error.value = `Could not open that conversation.`;
        return undefined;
    }
};

// Bring a tab with no visible transcript up to date with the daemon: attach to the turn running for its
// conversation right now, or, when nothing is running, replay its stored session. Shared by the restore
// watch above and by opening a fleet agent, which is what lets an agent an AUTOMATION opened for an outside
// message read as an ordinary chat: its whole transcript (the configured prompt, the message that woke it,
// the reply) exists only daemon-side until this runs.
// Returns whether the tab is now as current as the daemon can make it. False means the round-trip itself
// failed, not that there was nothing to show: the caller drops its hydrating mark then, so the next
// reachability flip tries again instead of leaving a restored tab visibly empty until the window is reloaded.
const hydrate = async (conversation: Conversation): Promise<boolean> => {
    /* The transcript has to be in place BEFORE attaching to anything live. reattach appends the running turn's
     * prompt bubble to whatever the transcript currently holds, and marks the conversation streaming, which
     * makes the cache paint stand down, so attaching first renders the live turn onto an EMPTY transcript and
     * then persists that stub over a perfectly good local mirror when the run settles. That is how a chat comes
     * back from a reload showing nothing but the message you just sent, with its whole history still sitting
     * intact in the daemon's session store.
     *
     * The mirror read is local and cheap, so it always goes first. Only when it comes up empty, a conversation
     * this device has never painted, e.g. a fleet agent opened for the first time, is the daemon's session
     * store worth waiting on before attaching; that is also the only case where there is nothing to show
     * meanwhile, so the round-trip costs nothing the user can see. */
    await conversation.paintCached();
    // Whether anything is THERE, not whether this call is what put it there: the restore sweep paints the
    // mirror on its own, so a paint that declines because the transcript is already populated must not be read
    // as "empty" and pay a session fetch the user would wait through on every restored tab.
    const seeded = conversation.messages.value.length === 0;
    // The one case with nothing to show while the daemon answers, say the transcript is on its way rather
    // than inviting the user to start over a conversation that merely hasn't arrived yet.
    conversation.loading.value = seeded;
    try {
        // A failed seed still lets the attach below run, a live turn is worth rendering either way, but it rides
        // out as the return value so the caller re-tries the read rather than settling for a tab that looks empty.
        const seededOk = seeded ? await replayStoredSession(conversation) : true;
        if (await conversation.reattach()) {
            return seededOk;
        }
        // With nothing running, what the mirror painted still has to be reconciled against the daemon, unless the
        // seeding above already read the very same store a moment ago.
        return seeded ? seededOk : await replayStoredSession(conversation);
    } finally {
        conversation.loading.value = false;
    }
};

/* Redraw a conversation from the daemon's own record, the authoritative transcript, and the only copy that
 * survives a device with no local mirror. False when the READ failed, as opposed to finding nothing to show, so
 * a transient round-trip failure is retried instead of leaving a restored tab visibly empty.
 *
 * Asked for EVERY provider. This used to return here unless the tab ran the Claude Code loop, on the reasoning
 * that /agents/:id/transcript could only answer for a harness with a readable session store, so a native
 * codex/grok or ACP tab never even asked, and opening one showed "Start a conversation with …" over a
 * conversation that had run for an hour. The daemon records what it streams now, whoever served it. */
const replayStoredSession = async (conversation: Conversation): Promise<boolean> => {
    // A fleet conversation is stable across runtime switches; its session id is not. Resolve registered agents
    // by conversation/worktree identity, then adopt the SDK session that actually supplied the transcript so the
    // next turn resumes what the user is looking at. History-menu tabs still mean one exact runtime session.
    let restored: TranscriptRow[] | undefined;
    /* WHERE THOSE ROWS SIT IN THE RECORD, when the daemon's own record is what supplied them. The read answers
     * with the most recent turns, so the chat has to know it is holding a window before it can offer to go
     * back through the rest. Absent for the SDK-session fallback below, which reads a foreign store with no
     * notion of the daemon's record positions and is therefore all it will ever have. */
    let page: { readonly from: number; readonly more: boolean } | undefined;
    // How the last turn ENDED, as the daemon has it, applied once the transcript below is in place: an offer to
    // carry on belongs under the work it is offering to carry on (see Conversation.adoptEnding).
    let ending: PickUp | undefined;
    if (conversation.registered.value) {
        const transcript = await fetchAgentTranscript(conversation);
        if (transcript === undefined) {
            return false;
        }
        if (transcript === `gone`) {
            /* THE ONE THING THAT UNLATCHES `registered`. The latch exists to outlive the roster, an archive
             * takes the entry off the board, a dropped stream takes the whole roster away, and neither means a
             * tab has stopped being an agent. But a NAMED 404 for this exact id is the daemon answering about
             * this conversation, and a tab that goes on claiming a fleet identity nobody has is unreachable
             * from the board while it sits in the strip: the registry half of the fleet has no entry for it and
             * the DRAFT half skips it for being registered, so it shows up nowhere on /agents and the
             * focus-leave sweep, which only ever takes unregistered drafts, can never take it either. That is
             * how an empty, untitled, permanent "New agent" tab is born, in a strip that is supposed to be the
             * board under another skin.
             *
             * Unlatched, it is what it actually is again: a conversation the daemon has never registered. Empty,
             * that makes it an ordinary untouched draft, so the sweep below takes it the way it takes any other;
             * with a transcript in it, it stays open and readable, and its next send registers it anew (the
             * daemon rebuilds the entry at begin, the same path an archived agent's next message takes). */
            conversation.registered.value = false;
            setConversations(conversations.value, activeId.value, `unlatch-registered`);
        } else {
            restored = transcript.messages;
            page = { from: transcript.from, more: transcript.more };
            ending = transcript.ending;
            /* THE SESSION AS THE DAEMON HAS IT, binding included, which is the only place the binding exists.
             *
             * This used to build the ref out of the TAB's own picks, and a tab's picks are what its NEXT turn
             * would use, not what the session was minted with. The two part company the moment anyone switches
             * account mid-chat, and the lie then ran both ways at once: switching back to the account that
             * actually holds the session announced "your next message starts a fresh session" and then went and
             * started one, re-seeding the whole transcript against a cold prompt cache; staying on the other
             * account promised a resume and sent that session's id out under a credential that never minted it.
             * Same forgery for the provider and the harness, one runtime switch away from the same outcome.
             *
             * A record with no session leaves the ref alone: the daemon is saying this conversation has nothing
             * to resume from ITS store, which is not the same as saying the tab's own session ref is wrong. */
            if (transcript.session !== undefined) {
                conversation.bindSession(transcript.session);
            }
        }
    }
    // Not an else: a tab that just lost its agent still has whatever SDK session it recorded, and that store is
    // a different one, the transcript may well be readable there after the registry entry is gone.
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
    /* A RUNNING TURN IS NOT IN THE RECORD, so a redraw from the record can only ever delete it. The daemon
     * writes a turn as it SETTLES, which means the answer in hand describes every turn but the live one, and
     * restoreMessages rebuilds the whole transcript. The live turn went with it: its prompt bubble, its tool
     * cards, and the card it was parked on. Nothing brought them back either, because a turn parked on a card
     * emits no further frames, leaving a spinner over a transcript that ends one turn early, with no card to
     * answer and a reload that reproduced it rather than fixing it.
     *
     * Asked AFTER the awaits, because that is where a stream gets in: this read and the attach that renders the
     * live turn are started by the same hydrate pass (and routinely by two of them at once), so the attach
     * lands first as often as not. Standing down costs nothing, whatever is streaming attached to a transcript
     * that was already painted, and the frames it is applying are the newer half of this same conversation.
     *
     * An empty replay is not a transcript either, it is the absence of one, the same distinction the mirror
     * makes when it refuses to save a blank. Painting it would blank a good cached transcript on any
     * daemon that answers but has nothing to say, which is exactly how a reopened tab goes empty. */
    if (restored.length > 0 && !conversation.streaming.value) {
        conversation.restoreMessages(restored, page);
    }
    /* AND THE OFFER TO PICK IT BACK UP, last, so it lands over a painted transcript rather than over the blank
     * pane a tab holds for the length of this read. Handed the verdict rather than gated on it: what a record
     * can and cannot settle about a chat in front of the user is the conversation's own judgement, and it
     * refuses this for a live turn, an empty transcript, or a pick-up its stream already armed (adoptEnding). */
    conversation.adoptEnding(ending);
    return true;
};

/* One hydrate at a time per conversation, and two of them at once is the ORDINARY case rather than a corner:
 * opening a fleet agent starts one, and the pane's fleet watcher starts another the moment the roster names the
 * conversation. Each holds its own daemon round-trip, so the slower one answers about a tab the faster one has
 * already moved on, which is how a redraw lands on top of a turn attached in between.
 *
 * A second WeakSet, because `hydrating` cannot answer this: it marks a tab as hydrated FOR GOOD (the reachability
 * sweep reads it as "already done"), while the fleet watcher's whole job is to hydrate the same tab AGAIN when the
 * daemon says something about it changed. This one is in-flight only, and clears however the pass ends. */
const hydrateInFlight = new WeakSet<Conversation>();

// Hydrate a tab once, holding the mark only while (and after) the daemon actually answered. Exported for the
// pane's fleet watcher (ChatPane), which calls it whenever the fleet settles or starts something about a
// conversation this tab did not stream itself.
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
        // A hydrate that could not reach the daemon leaves the tab exactly as it stands, and the reachability
        // watch below runs it again when the connection is back. Caught rather than left to reject: nothing
        // awaits this call, so an unreachable daemon was raising an unhandled rejection per open tab.
        .catch(() => hydrating.delete(conversation))
        .finally(() => hydrateInFlight.delete(conversation));
};

// Restored tabs persist as session + title only, once their daemon is reachable, first try to ATTACH: a
// turn may be running for the conversation daemon-side (started before the reload, or by another window or
// device), and attaching renders it live mid-stream. Only when nothing is running does the flat transcript
// hydrate from the session store. `conversations` is in the source so tabs restored by a sandbox switch
// (when reachability may already be true and never flip) are still picked up; the WeakSet keeps unrelated
// tab churn from re-firing work already in flight. A registered tab hydrates from /agents/:id/transcript, which
// answers for every provider (the daemon records what it streams); an unregistered one still means one exact
// runtime session and reads /sessions/:id, which is the Claude Code SDK's store alone.
const hydrating = new WeakSet<Conversation>();
// Conversations showing a locally cached transcript rather than a daemon-confirmed one. They still hydrate,
// the cache decides what the user looks at during the round-trip, not whether the round-trip happens, so the
// "already has messages, leave it alone" guard below must not mistake a painted mirror for live content.
const painted = new WeakSet<Conversation>();

// Paint every restored tab from the local mirror immediately, without waiting for the sandbox to be reachable
// (see transcriptCache). This is the whole point of the cache: a reopened chat is readable at once instead of
// after a probe, a tunnel round-trip, and a session-store read.
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

/* A TURN THIS BROWSER DID NOT START, on a tab that is already open, attach to it.
 *
 * A tab hydrates when it opens, and that is the only moment it ever asked the daemon what was going on. Fine
 * for a chat you type into, and wrong for every session started somewhere else: a workflow's steps are opened
 * the instant the run exists, a beat BEFORE the scheduler starts their turns, so the attach probe finds
 * nothing and the pane sits on "start a conversation" while the agent behind it works. Nothing re-asked, so
 * the only cure was clicking the card again, which is what "one window left with no content" was.
 *
 * The roster is the signal, and it arrives on the events stream rather than on a timer (useAgents.setAgents):
 * the daemon publishes a card the moment a turn opens. Only a tab with NOTHING in it is touched, a transcript
 * already painted has its own reconciliation, and a streaming one IS the stream.
 */
export const attachStarted = (ids: ReadonlySet<string>): void => {
    for (const conversation of conversations.value) {
        if (!ids.has(conversation.conversationId) || conversation.streaming.value || conversation.messages.value.length > 0) {
            continue;
        }
        hydrateOnce(conversation);
    }
};

// A singleton per window (hotReload.ts): a hot update that re-ran this module would mint a second hydration ledger
// beside the one the rest of the app still reads.
reloadOnHotUpdate(import.meta);
