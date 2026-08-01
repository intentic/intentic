import type { AgentEvent } from "@intentic/sandbox-contract";
import { computed, type ComputedRef, shallowRef } from "vue";
import { recordPerf } from "../perf";
import type { CardKind, ChatMessage } from "./transcript";
import {
    appendMessage,
    appendNotice,
    applyTurnFrame,
    emptyTurnState,
    flushPending,
    revealPending,
    type TurnEffect,
    type TurnState,
} from "./turnReducer";
import type { TurnContext } from "./turnStream";

/* THE TRANSCRIPT AS IT IS BEING WRITTEN: the state every frame moves through, the clock that decides WHEN a
 * frame is shown, and every write anyone makes to it. One unit because the buffering is the reason the writes
 * cannot be independent — a Stop's notice appended without folding the frames that already arrived would read
 * as the agent working after being stopped.
 *
 * What a frame MEANS is the reducer's (turnReducer.ts) and what to DO about it is the Conversation's; this owns
 * only the state, the timing, and the ordering between them. */

/* WHICH WINDOW'S FRAMES THE TRANSCRIPT RUNS ON — announced by the panel (ChatPanel, on mount and on every
 * pop-out move), because the window a transcript is DISPLAYED in is not always the window this module lives in.
 *
 * A popped-out chat is DOM teleported into a second real window while its JS keeps running in the opener's
 * realm (composables/usePopout.ts). Rendering steps belong to a window: a browser gives none — no animation
 * frames, no observer deliveries — to one that is hidden, minimized or fully occluded, and that is the normal
 * state of the app window while the user works in the chat window in front of it. So a clock armed on the
 * OPENER simply stops: frames pile up in the inbox, the typewriter holds its text, and the panel out there
 * looks alive (its keeper is still being answered — see usePopout's liveness contract, which proves the realm
 * can run code, not that it can paint) while nothing on it moves. Every "the popped-out chat stopped
 * reacting" report is this. useStickToBottom and terminalSession.observeHost re-home their observers for the
 * same reason; this is the transcript's half of it.
 *
 * Undefined until the panel mounts — and in tests, where this module's own realm is the only answer there is. */
export const transcriptView = shallowRef<Window | undefined>(undefined);

// How long a tick waits on a frame that may never come. The clock's rate is the frame's — this only bounds the
// lag when NO window is painting the transcript: both windows minimized, or a pop-out closed while a frame it
// owed was still pending, which would otherwise leave the clock armed forever and the conversation deaf for
// the rest of the session. Deliberately on this realm's timer, the one that outlives every pop-out window; a
// browser throttles it to about a second while the page is hidden, which is the right rate for a transcript
// nobody is looking at.
const CLOCK_FALLBACK_MS = 120;

// An assistant bubble a turn opened for an answer that never arrived. A turn the daemon refused before running
// it leaves one behind, and a rewound turn must take it back too rather than leave a blank agent reply.
const blank = (message: ChatMessage): boolean =>
    message.role === `assistant` &&
    message.text === `` &&
    (message.thinking ?? ``) === `` &&
    message.tools === undefined &&
    message.plan === undefined &&
    message.question === undefined &&
    message.permission === undefined;

export class TranscriptClock {
    /* The transcript, the turn's current bubble, the id allocator, and the typewriter's undrained buffer — one
     * value, moved through the pure reducer in turnReducer.ts. Holding them together is what makes the frame
     * rules testable without a conversation: every question the reducer asks (does this bubble hold prose yet,
     * which bubble does a card attach to) is answerable from this object alone.
     *
     * shallowRef, NOT ref — and the difference is the single largest cost in a long chat. A deep `ref` hands its
     * value to Vue's reactive(), which lazily wraps every object REACHED THROUGH IT in a Proxy: the messages
     * array, each message, each message's tool array, each tool, each tool's children. The reducer is pure, so
     * it replaces that object graph on essentially every frame — which invalidates the proxy cache and makes the
     * renderer re-wrap the reachable graph on the next read. At 60 typewriter ticks a second over a
     * several-hundred-message transcript that is tens of thousands of proxy allocations per second, all of it
     * to observe mutations that CANNOT HAPPEN: nothing anywhere writes through `state.value`, every transition
     * goes through the reducer and assigns a whole new object.
     *
     * A shallowRef triggers on exactly the thing that does happen — the identity of `state.value` changing — and
     * hands the renderer the raw objects. Same reactivity, none of the proxying. (useChat's `conversations` is
     * shallow for a related reason; see its comment.) */
    private readonly state = shallowRef<TurnState>(emptyTurnState);

    readonly messages: ComputedRef<readonly ChatMessage[]> = computed(() => this.state.value.messages);

    /* Armed-or-not, with no FRAME handle and no cancellation: a tick that finds nothing to do returns, so
     * draining the work out from under an armed tick (catchUp, settle) needs no cancel and costs one empty
     * callback. Holding a handle instead is what a synchronous test clock breaks — it runs the callback
     * during `requestAnimationFrame` itself, so the id lands in the field AFTER the tick that should have
     * cleared it and every later cancel aims at a frame that already came.
     *
     * The FALLBACK timer below is held, because it is the one thing that must not fire twice: a stale one is a
     * second full fold-and-reveal per tick, at the reveal's own expense. It is armed BEFORE the frame is asked
     * for, so the same synchronous test clock finds it already in the field and clears it. */
    private clockArmed = false;
    private clockFallback: ReturnType<typeof setTimeout> | undefined;

    /* Frames waiting for the next tick, with the turn each arrived under (a stream holds one turn, but the
     * buffer outlives any single `follow` call, so the pairing has to be explicit).
     *
     * Buffering is what stops a burst from costing a render apiece. The daemon emits a frame per SDK message
     * — hundreds over an answer, and a REPLAY delivers a whole run's log as fast as the socket can carry it —
     * while the screen can only show 60 a second. Applied on arrival, every one of those paid a full
     * transcript rebuild plus a Vue render to draw a state nobody ever saw. */
    private readonly inbox: { readonly event: AgentEvent; readonly turn: TurnContext }[] = [];

    /* `applied` runs the effects a folded frame raised, in arrival order — the conversation's half of a frame,
     * and the reason the fold hands them back instead of applying them: what an effect DOES is state this has
     * no business reaching for. */
    constructor(private readonly applied: (event: AgentEvent, turn: TurnContext, effects: readonly TurnEffect[]) => void) {}

    // One frame in: buffered for the next tick rather than applied on the spot, so a burst costs one render
    // instead of one apiece (see `inbox`). Nothing is decided here — the ordering between a frame's transition
    // and its effects is `tick`'s, and it has to stay exact.
    push(event: AgentEvent, turn: TurnContext): void {
        this.inbox.push({ event, turn });
        this.schedule();
    }

    // Run a tick on the next paint of the window the transcript is IN (transcriptView — a popped-out panel's is
    // not this realm's), unless one is already owed. The clock only runs while there is something for it to do
    // — buffered frames, or text still being revealed — so an idle conversation holds no timer.
    private schedule(): void {
        if (this.clockArmed) {
            return;
        }
        this.clockArmed = true;
        this.clockFallback = setTimeout(() => this.tick(), CLOCK_FALLBACK_MS);
        // A closed window paints nothing ever again, and the panel hears about one a flush after it goes — so
        // the frames of the window that is still here are the better bet for the beat in between.
        const view = transcriptView.value;
        (view === undefined || view.closed ? globalThis : view).requestAnimationFrame(() => this.tick());
    }

    /* Fold every buffered frame into `from`, returning the state they produce and the effects they raised in
     * arrival order. Pure over the buffer — the caller owns the write and whatever else rides on it — because
     * the two callers want different endings: a tick reveals text and keeps the clock, a settle drains it.
     *
     * The fold runs the reducer per frame; each frame's transition genuinely depends on the one before it, so
     * they cannot be merged. What it does NOT do is write per frame, and that is the whole saving: the
     * reducer's cost is a transcript rebuild, Vue's is a render of one, and only the latter was being paid N
     * times over to display a single state.
     *
     * Effects come back rather than being applied here, and are never recomputed from the folded state — a
     * frame's effects depend on the state it was applied TO, so a second pass against the batch's final state
     * would raise a different (wrong) set, and pay for the whole fold again to do it. */
    private foldInbox(from: TurnState): {
        readonly state: TurnState;
        readonly applied: readonly { readonly event: AgentEvent; readonly turn: TurnContext; readonly effects: readonly TurnEffect[] }[];
    } {
        const batch = this.inbox.splice(0, this.inbox.length);
        const applied: { readonly event: AgentEvent; readonly turn: TurnContext; readonly effects: readonly TurnEffect[] }[] = [];
        let state = from;
        for (const { event, turn } of batch) {
            const result = applyTurnFrame(state, event, { userMessageId: turn.userMessageId });
            state = result.state;
            applied.push({ event, turn, effects: result.effects });
        }
        return { state, applied };
    }

    // Hand a fold's frames to the conversation, in arrival order. Kept in one place because that order is
    // load-bearing for state the conversation holds ACROSS frames (a provider_retry and the frame that answers
    // it are routinely in one batch), and a reshuffle here would settle it on whichever won.
    private runApplied(applied: ReturnType<TranscriptClock[`foldInbox`]>[`applied`]): void {
        for (const { event, turn, effects } of applied) {
            this.applied(event, turn, effects);
        }
    }

    // One paint's worth of transcript work: apply the frames that arrived since the last tick, then reveal the
    // typewriter's next slice, in ONE write to `state.value`.
    private tick(): void {
        this.clockArmed = false;
        clearTimeout(this.clockFallback);
        // The work may have been taken out from under this tick by a catchUp or a settle — that is the trade
        // for holding no frame handle, and an empty tick is cheaper than the cancellation bookkeeping was.
        if (this.inbox.length === 0 && this.state.value.pending === undefined) {
            return;
        }
        /* Measured by hand rather than through `trackPerf`: this is synchronous and runs on every paint of a
         * streaming turn, so it cannot afford a closure and a promise per tick.
         *
         * Two spans, not one, because the tick's two jobs fail differently and the fix for each is elsewhere.
         * `chat.frame` is the fold: the reducer rebuilds the message list on most frames, so its cost scales
         * with TRANSCRIPT LENGTH while the frame rate is set by the model — which is why a chat feels fine for
         * the first few exchanges and turns to treacle in a long one. `chat.type` is the typewriter's reveal,
         * which pays that same rebuild to append a few characters to one bubble and runs on EVERY paint of an
         * answer, buffered frames or not.
         *
         * `messages` rides along so that correlation is visible in one line instead of inferred, and `frames`
         * says how many the fold carried: the same total work in fewer, fatter ticks is the buffer doing its
         * job, and a fold that stays slow at `frames: 1` is a reducer problem rather than a clock one. */
        const from = performance.now();
        const { state, applied } = this.foldInbox(this.state.value);
        const folded = performance.now();
        // Reveal against the state the fold just produced, so the tick's single write carries both jobs.
        const next = state.pending !== undefined ? revealPending(state) : state;
        this.state.value = next;
        if (applied.length > 0) {
            recordPerf(`chat.frame`, folded - from, { frames: applied.length, messages: next.messages.length });
        }
        if (next !== state) {
            recordPerf(`chat.type`, performance.now() - folded, { messages: next.messages.length });
        }
        this.runApplied(applied);
        // Text still buffered keeps the clock running; so do frames that landed during the tick itself.
        if (this.state.value.pending !== undefined || this.inbox.length > 0) {
            this.schedule();
        }
    }

    /* Bring the transcript up to date NOW, off the clock, without disturbing the typewriter: text still being
     * revealed goes on revealing (the clock is re-armed for it). For the one caller that needs the transcript
     * exact at an instant the buffer would otherwise straddle — the replay/live boundary in followRun.
     *
     * Buffering is invisible to everything that reads the transcript on its own schedule; it is only visible
     * to a reader that has to be right about a PARTICULAR frame. That is this, and there is one of them. */
    catchUp(): void {
        const { state, applied } = this.foldInbox(this.state.value);
        this.state.value = state;
        this.runApplied(applied);
        if (this.state.value.pending !== undefined) {
            this.schedule();
        }
    }

    /* Leave the transcript FINISHED: every buffered frame applied, and the typewriter's buffer drained rather
     * than animated, in one write. For a turn that is over — ended of its own accord, or stopped — where what
     * comes next (persist, the queue drain) must not read a torn transcript or a half-typed bubble.
     *
     * The clock is left to expire on its own; an armed tick finds the inbox empty and no pending text, and
     * returns.
     *
     * Buffered frames are applied rather than dropped even on an abort: they arrived, so they are part of the
     * run's story, and a Stop that swallowed the last frames before it would leave a transcript the daemon's
     * own log disagrees with. (A card taking the bubble over flushes inside the reducer, where the rule
     * belongs.) */
    settle(): void {
        const { state, applied } = this.foldInbox(this.state.value);
        this.state.value = flushPending(state);
        this.runApplied(applied);
    }

    /* A transcript write made on the USER'S clock rather than the stream's — a control action's notice, a card
     * freezing into its answer, a Stop cancelling what was open.
     *
     * Folds the buffered frames before applying `next`, and that ordering is the whole point: a Stop pressed
     * mid-answer would otherwise append "Stopped." above frames that had already reached this tab, and the
     * transcript would read as though the agent kept working after being stopped. Applying frames on arrival
     * used to make this automatic; buffering them for the next paint (see `inbox`) made it something the
     * writes on the other clock have to say out loud.
     *
     * Free when the buffer is empty — which is every call from inside a fold's effects, where it already ran. */
    write(next: (state: TurnState) => TurnState): void {
        this.catchUp();
        this.state.value = next(this.state.value);
    }

    append(message: Omit<ChatMessage, "id">): number {
        const id = this.state.value.nextId;
        this.state.value = appendMessage(this.state.value, message);
        return id;
    }

    // A small muted system line marking a control action (dismissed / kept planning / approved / stopped).
    // `extra` is the follow-up offer or unfinished wait a notice can carry — see turnReducer's appendNotice.
    notice(text: string, extra?: Pick<ChatMessage, "noticeAction" | "noticeWait">): void {
        this.write((state) => appendNotice(state, text, extra));
    }

    // Hang an interactive card (plan / question / permission) on a bubble — and, with the answered card, freeze
    // that answer into the transcript. One writer for all three: they differ in what they ask, not in how they
    // attach.
    attachCard(id: number, card: Pick<ChatMessage, CardKind>): void {
        this.write((state) => ({
            ...state,
            messages: state.messages.map((message) => (message.id === id ? { ...message, ...card } : message)),
        }));
    }

    // Open the turn's first bubble: a fresh empty assistant message the frames stream into, so the typing
    // indicator shows the moment the turn starts rather than on the first delta.
    openBubble(): void {
        const id = this.append({ role: `assistant`, text: ``, thinking: `` });
        this.state.value = { ...this.state.value, bubbleId: id };
    }

    /* THE BUBBLE AN ATTACHED RUN'S PROMPT IS ALREADY IN. Two different situations put it there, and in both the
     * alternative is showing the user saying the same thing twice.
     *
     * RESTORED-AND-LIVE. The daemon's session store holds a turn from the moment it starts — the SDK writes the
     * user message before the first token — so a hydrate that lands mid-turn restores that turn and then attaches
     * to the very same run. On a fleet agent, whose whole chat is often one long turn, rendering the head again
     * reads as the entire conversation duplicated; reopening the tab adds another copy, because the duplicate is
     * what got mirrored to the cache in between.
     *
     * RESUMED. The daemon re-ran a turn something killed (turn-resume.ts). Its prompt is the same words behind a
     * note the caller has already stripped, so it matches the bubble the user really typed, one run up.
     *
     * `truncate` is the whole difference between them, and it is the difference between "this bubble's tail is
     * about to be re-rendered" and "this bubble's tail is somebody else's work". The restored copy is followed by
     * a partial replay of the SAME run, which the live frames replay from seq 0 — so it comes off. A resumed run's
     * bubble is followed by whatever the run that DIED had already streamed, plus the notice explaining the
     * interruption; nothing will ever re-render those, so they stay and the resumed answer appends below them.
     *
     * Either way the bubble itself stays, with the attachment chips and checkpoint a replay has no way to rebuild.
     * Returns its id, or undefined when the transcript's tail is not about this prompt at all.
     *
     * Matched on the LAST user message only, and only by whole text: the stored prompt keeps an editor-context
     * note the daemon appended after it (the run's own prompt is the bare text), which is why a `${prompt}\n\n`
     * prefix counts — but a bare prefix does not, or a live "Continue" would swallow a restored "Continue with
     * the tests" sitting above it. */
    reuseUserBubble(prompt: string, truncate: boolean): number | undefined {
        const wanted = prompt.trim();
        if (wanted.length === 0) {
            return undefined;
        }
        const messages = this.state.value.messages;
        const index = messages.findLastIndex((message) => message.role === `user`);
        const candidate = index === -1 ? undefined : messages[index];
        if (candidate === undefined) {
            return undefined;
        }
        const restored = candidate.text.trim();
        if (restored !== wanted && !restored.startsWith(`${wanted}\n\n`)) {
            return undefined;
        }
        if (truncate) {
            this.state.value = { ...this.state.value, messages: messages.slice(0, index + 1), bubbleId: null };
        }
        return candidate.id;
    }

    // Take a user bubble the daemon turned away back OUT of the transcript, and hand it to the caller to hold.
    // A turn refused before it ran produced nothing, so leaving the bubble in place would show a message as
    // said-and-answered when the agent never saw it — and a later replay would then say it twice. The blank
    // assistant bubble the refused turn opened comes off with it.
    takeBackUserBubble(userMessageId: number): ChatMessage | undefined {
        const index = this.messages.value.findIndex((message) => message.id === userMessageId);
        const bubble = this.messages.value[index];
        if (bubble === undefined || bubble.role !== `user`) {
            return undefined;
        }
        this.state.value = {
            ...this.state.value,
            messages: this.state.value.messages.filter((message, at) => message.id !== userMessageId && !(at > index && blank(message))),
            bubbleId: null,
        };
        return bubble;
    }

    // Replace the transcript with messages that carry no ids of their own — a branch's inherited turns, a
    // daemon replay — allocating fresh ones as they land.
    rebuild(messages: readonly Omit<ChatMessage, "id">[]): void {
        this.state.value = messages.reduce((state, message) => appendMessage(state, message), emptyTurnState);
    }

    // Replace the transcript with messages that keep the ids they already carry (the local mirror's), resuming
    // the allocator ABOVE them — otherwise the next notice would collide with a restored bubble.
    adopt(messages: readonly ChatMessage[]): void {
        this.state.value = { ...emptyTurnState, messages, nextId: Math.max(0, ...messages.map((message) => message.id)) + 1 };
    }
}
