import type { TranscriptCards, TranscriptRow } from "@intentic/sandbox-contract";
import { computed, type ComputedRef, ref, shallowRef } from "vue";
import { recordPerf } from "../perf";
import type { ChatMessage } from "./transcript";
import { appendMessage, applyPatch, attachRun, emptyTranscriptState, flushPending, revealPending, type TranscriptState } from "./transcriptState";
import type { AttachEntry, AttachHead, TurnContext } from "./turnStream";

/* THE TRANSCRIPT AS IT IS BEING WRITTEN: the state every entry moves through, the clock that decides WHEN an
 * entry is shown, and every write anyone makes to it. One unit because the buffering is the reason the writes
 * cannot be independent, a Stop's notice appended without applying the patches that already arrived would read
 * as the agent working after being stopped.
 *
 * What a row IS was decided on the daemon (transcript-fold.ts); what to DO about a fact is the Conversation's;
 * this owns only the state, the timing, and the ordering between them. */

/* THE TRANSCRIPT RUNS ON ITS OWN WINDOW'S FRAMES, which is worth a note only because it used to be the hardest
 * thing in this file to get right. A floating chat was DOM teleported into a second window while its JS kept
 * running in the opener's realm, and rendering steps belong to a window: a browser gives none, no animation
 * frames, no observer deliveries, to one that is hidden, minimized or fully occluded, which is the normal state
 * of the app window while the user works in the chat window in front of it. So the clock stopped: entries piled
 * up in the inbox, the typewriter held its text, and the panel out there looked alive while nothing on it moved.
 * A floating panel is rendered by its own window now (composables/floating.ts), so the transcript, this clock and
 * the entries it runs on are the same window's by construction, and there is no view to announce or re-home. */

// How long a tick waits on a frame that may never come. The clock's rate is the frame's, this only bounds the
// lag when nothing is painting: a minimized window, which would otherwise leave the clock armed forever and the
// conversation deaf for the rest of the session. A browser throttles this timer to about a second while the page
// is hidden, which is the right rate for a transcript nobody is looking at.
const CLOCK_FALLBACK_MS = 120;

export class TranscriptClock {
    /* The transcript, the id allocator, the attached run's place in it, and the typewriter's undrained buffer,
     * one value, moved through the pure transitions in transcriptState.ts.
     *
     * shallowRef, NOT ref, and the difference is the single largest cost in a long chat. A deep `ref` hands its
     * value to Vue's reactive(), which lazily wraps every object REACHED THROUGH IT in a Proxy: the messages
     * array, each message, each message's tool array, each tool, each tool's children. The transitions are pure,
     * so they replace that object graph on essentially every entry, which invalidates the proxy cache and makes
     * the renderer re-wrap the reachable graph on the next read. At 60 typewriter ticks a second over a
     * several-hundred-message transcript that is tens of thousands of proxy allocations per second, all of it
     * to observe mutations that CANNOT HAPPEN: nothing anywhere writes through `state.value`, every transition
     * assigns a whole new object.
     *
     * A shallowRef triggers on exactly the thing that does happen, the identity of `state.value` changing, and
     * hands the renderer the raw objects. Same reactivity, none of the proxying. (useChat's `conversations` is
     * shallow for a related reason; see its comment.) */
    private readonly state = shallowRef<TranscriptState>(emptyTranscriptState);

    readonly messages: ComputedRef<readonly ChatMessage[]> = computed(() => this.state.value.messages);

    /* Armed-or-not, with no FRAME handle and no cancellation: a tick that finds nothing to do returns, so
     * draining the work out from under an armed tick (catchUp, settle) needs no cancel and costs one empty
     * callback. Holding a handle instead is what a synchronous test clock breaks, it runs the callback
     * during `requestAnimationFrame` itself, so the id lands in the field AFTER the tick that should have
     * cleared it and every later cancel aims at a frame that already came.
     *
     * The FALLBACK timer below is held, because it is the one thing that must not fire twice: a stale one is a
     * second full fold-and-reveal per tick, at the reveal's own expense. It is armed BEFORE the frame is asked
     * for, so the same synchronous test clock finds it already in the field and clears it. */
    private clockArmed = false;
    private clockFallback: ReturnType<typeof setTimeout> | undefined;

    /* IS ANYONE LOOKING AT THIS TRANSCRIPT, set by the pane holding it (ChatPane), true for the pane with the
     * focus and false for every other one.
     *
     * The typewriter is an animation, and an animation is worth paying for only where the eye is. With several
     * chats side by side in a floating window, N transcripts typing at once is N things moving in the reader's
     * periphery while they try to read one, the single fastest way to make a split unbearable. So an unwatched
     * transcript SETTLES each batch whole instead of revealing it a slice per paint: the same text, the same
     * order, arriving as it lands rather than at reading speed.
     *
     * It is the cost answer too. The reveal is the per-paint work (`chat.type` below) and it rebuilds the list to
     * append a few characters to one bubble; settling pays that once per batch instead of once per paint, which
     * is what keeps four live agents on screen affordable. Watched by default, so a conversation nobody has
     * claimed, a test, a background tab's first frames, behaves exactly as it always has. */
    readonly watched = ref(true);

    /* Entries waiting for the next tick, with the turn each arrived under (a stream holds one turn, but the
     * buffer outlives any single `follow` call, so the pairing has to be explicit).
     *
     * Buffering is what stops a burst from costing a render apiece. The daemon sends a patch per delta, hundreds
     * over an answer, while the screen can only show 60 a second. Applied on arrival, every one of those paid a
     * transcript rebuild plus a Vue render to draw a state nobody ever saw. */
    private readonly inbox: { readonly entry: AttachEntry; readonly turn: TurnContext; readonly replay: boolean }[] = [];

    /* `applied` runs the conversation's half of an entry, in arrival order: what a fact DOES is state this has
     * no business reaching for, and even a patch has a consequence beyond the rows (a wait that ends, a write to
     * record). Told whether the entry is a replay, so a fact delivered twice is applied once. */
    constructor(private readonly applied: (entry: AttachEntry, turn: TurnContext, replay: boolean) => void) {}

    // One entry in: buffered for the next tick rather than applied on the spot, so a burst costs one render
    // instead of one apiece (see `inbox`). Nothing is decided here, the ordering between an entry's transition
    // and its consequence is `tick`'s, and it has to stay exact.
    push(entry: AttachEntry, turn: TurnContext, replay = false): void {
        this.inbox.push({ entry, turn, replay });
        this.schedule();
    }

    // Run a tick on this window's next paint, unless one is already owed. The clock only runs while there is
    // something for it to do, buffered entries, or text still being revealed, so an idle conversation holds no
    // timer.
    private schedule(): void {
        if (this.clockArmed) {
            return;
        }
        this.clockArmed = true;
        this.clockFallback = setTimeout(() => this.tick(), CLOCK_FALLBACK_MS);
        globalThis.requestAnimationFrame(() => this.tick());
    }

    /* Apply every buffered entry to `from`, returning the state they produce and the entries applied, in arrival
     * order. Pure over the buffer, the caller owns the write and whatever else rides on it, because the two
     * callers want different endings: a tick reveals text and keeps the clock, a settle drains it.
     *
     * Each patch's transition depends on the one before it, so they cannot be merged. What this does NOT do is
     * write per entry, and that is the whole saving: a transition's cost is a list rebuild, Vue's is a render of
     * one, and only the latter was being paid N times over to display a single state. */
    private foldInbox(from: TranscriptState): {
        readonly state: TranscriptState;
        readonly applied: readonly { readonly entry: AttachEntry; readonly turn: TurnContext; readonly replay: boolean }[];
    } {
        const batch = this.inbox.splice(0, this.inbox.length);
        let state = from;
        for (const { entry } of batch) {
            if (entry.kind === `patch`) {
                state = applyPatch(state, entry.patch, this.watched.value);
            }
        }
        return { state, applied: batch };
    }

    // Hand a fold's entries to the conversation, in arrival order. Kept in one place because that order is
    // relied on for state the conversation holds ACROSS entries (a provider_retry and the entry that answers
    // it are routinely in one batch), and a reshuffle here would settle it on whichever won.
    private runApplied(applied: ReturnType<TranscriptClock[`foldInbox`]>[`applied`]): void {
        for (const { entry, turn, replay } of applied) {
            this.applied(entry, turn, replay);
        }
    }

    // One paint's worth of transcript work: apply the entries that arrived since the last tick, then reveal the
    // typewriter's next slice, in ONE write to `state.value`.
    private tick(): void {
        this.clockArmed = false;
        clearTimeout(this.clockFallback);
        // The work may have been taken out from under this tick by a catchUp or a settle, that is the trade
        // for holding no frame handle, and an empty tick is cheaper than the cancellation bookkeeping was.
        if (this.inbox.length === 0 && this.state.value.pending === undefined) {
            return;
        }
        /* Measured by hand rather than through `trackPerf`: this is synchronous and runs on every paint of a
         * streaming turn, so it cannot afford a closure and a promise per tick.
         *
         * Two spans, not one, because the tick's two jobs fail differently and the fix for each is elsewhere.
         * `chat.frame` is the fold: a patch rebuilds the message list, so its cost scales with TRANSCRIPT LENGTH
         * while the rate is set by the model, which is why a chat feels fine for the first few exchanges and
         * turns to treacle in a long one. `chat.type` is the typewriter's reveal, which pays that same rebuild
         * to append a few characters to one bubble and runs on EVERY paint of an answer, buffered entries or not. */
        const from = performance.now();
        const { state, applied } = this.foldInbox(this.state.value);
        const folded = performance.now();
        // Reveal against the state the fold just produced, so the tick's single write carries both jobs, a
        // slice at a time where someone is reading it, the whole buffer where nobody is (see `watched`).
        const next = state.pending === undefined ? state : this.watched.value ? revealPending(state) : flushPending(state);
        this.state.value = next;
        if (applied.length > 0) {
            recordPerf(`chat.frame`, folded - from, { frames: applied.length, messages: next.messages.length });
        }
        if (next !== state) {
            recordPerf(`chat.type`, performance.now() - folded, { messages: next.messages.length });
        }
        this.runApplied(applied);
        // Text still buffered keeps the clock running; so do entries that landed during the tick itself.
        if (this.state.value.pending !== undefined || this.inbox.length > 0) {
            this.schedule();
        }
    }

    /* Bring the transcript up to date NOW, off the clock, without disturbing the typewriter: text still being
     * revealed goes on revealing (the clock is re-armed for it). User-clock writes call this before applying
     * their own state so they cannot overtake entries that have already reached the tab. */
    catchUp(): void {
        const { state, applied } = this.foldInbox(this.state.value);
        this.state.value = state;
        this.runApplied(applied);
        if (this.state.value.pending !== undefined) {
            this.schedule();
        }
    }

    /* Leave the transcript FINISHED: every buffered entry applied, and the typewriter's buffer drained rather
     * than animated, in one write. For a turn that is over, ended of its own accord, or stopped, where what
     * comes next (persist, the queue drain) must not read a torn transcript or a half-typed bubble.
     *
     * The clock is left to expire on its own; an armed tick finds the inbox empty and no pending text, and
     * returns.
     *
     * Buffered entries are applied rather than dropped even on an abort: they arrived, so they are part of the
     * run's story, and a Stop that swallowed the last patches before it would leave a transcript the daemon's
     * own rows disagree with. */
    settle(): void {
        const { state, applied } = this.foldInbox(this.state.value);
        this.state.value = flushPending(state);
        this.runApplied(applied);
    }

    /* A transcript write made on the USER'S clock rather than the stream's, a control action's notice, a card
     * freezing into its answer, a Stop cancelling what was open.
     *
     * Applies the buffered entries before applying `next`, and that ordering is the whole point: a Stop pressed
     * mid-answer would otherwise append "Stopped." above patches that had already reached this tab, and the
     * transcript would read as though the agent kept working after being stopped.
     *
     * Free when the buffer is empty, which is every call from inside a fold's consequences, where it already ran. */
    write(next: (state: TranscriptState) => TranscriptState): void {
        this.catchUp();
        this.state.value = next(this.state.value);
    }

    /* A row this window writes. A user bubble is stamped with the moment it lands (TranscriptRow.sentAt), which
     * for every bubble this tab appends IS when it was sent, because the append is what sending does; a caller
     * that knows better says so and is left alone.
     *
     * Here rather than in the transitions: `rebuild` and `adopt` pour whole transcripts through those (a
     * replayed record, a fork's inherited turns), and a clock in there would re-stamp every restored message
     * with the moment the tab happened to open it. */
    append(message: Omit<ChatMessage, "id">): number {
        const id = this.state.value.nextId;
        const stamped = message.role === `user` && message.sentAt === undefined ? { ...message, sentAt: Date.now() } : message;
        this.write((state) => appendMessage(state, stamped));
        return id;
    }

    // A small muted line this window writes on the user's clock (a switch, a rewind, a press that armed
    // something). LOCAL by construction: the daemon's own notices arrive as rows, and only a row this window
    // drew is one a fork must count out.
    notice(text: string, extra?: Pick<ChatMessage, "noticeAction" | "noticeWait">): number {
        return this.append({ role: `notice`, text, local: true, ...extra });
    }

    // Freeze a card into its answer the instant the daemon accepted it: the `resolved` patch that follows says
    // the same thing (card-status.ts is the one derivation), so this only closes the gap between the click and
    // the round trip, where a card still reading `pending` would offer its buttons a second time.
    attachCard(id: number, cards: TranscriptCards): void {
        this.write((state) => ({
            ...state,
            messages: state.messages.map((message) => (message.id === id ? { ...message, ...cards } : message)),
        }));
    }

    /* TAKE THE ATTACHED RUN'S ROWS, WHOLE, from its head. Everything buffered lands first, so a patch from an
     * earlier attach of the same run cannot land on the rows that just replaced its target. `drawn` is the bubble
     * this window drew ahead of the head (a send's own), which the run's rows replace in place. Returns where the
     * run's rows start and the user bubble the turn answers, so the stream's context can name them. */
    attachRun(head: AttachHead, drawn?: number): { readonly base: number; readonly userMessageId: number | undefined } {
        this.catchUp();
        const next = attachRun(this.state.value, head, drawn);
        this.state.value = next;
        const base = next.attached?.base ?? next.messages.length;
        return { base, userMessageId: next.messages.slice(base).find((message) => message.role === `user`)?.id };
    }

    // Take a user bubble the daemon turned away back OUT of the transcript, and hand it to the caller to hold.
    // A turn refused before it ran produced nothing, so leaving the bubble in place would show a message as
    // said-and-answered when the agent never saw it, and a later attach would then say it twice.
    takeBackUserBubble(userMessageId: number): ChatMessage | undefined {
        const index = this.messages.value.findIndex((message) => message.id === userMessageId);
        const bubble = this.messages.value[index];
        if (bubble === undefined || bubble.role !== `user`) {
            return undefined;
        }
        this.state.value = { ...this.state.value, messages: this.state.value.messages.filter((message) => message.id !== userMessageId) };
        return bubble;
    }

    // Replace the transcript with rows that carry no ids of their own, a branch's inherited turns, the daemon's
    // record, allocating fresh ones as they land. Nothing is attached afterwards: whatever run these rows came
    // out of, its place in this list is gone with them.
    rebuild(rows: readonly TranscriptRow[]): void {
        this.state.value = rows.reduce((state, row) => appendMessage(state, row), emptyTranscriptState);
    }

    /* Put an older page ABOVE what is already drawn, for a reader who has scrolled to the top of the window the
     * chat opened on. Everything standing keeps its id and its position, which is what makes this safe to do
     * while a turn is streaming: a patch addresses the message it has always addressed, and `pending` (the
     * typewriter's half-revealed bubble) is untouched.
     *
     * The arriving rows allocate ABOVE the current high-water mark rather than below the first drawn message.
     * Ids here are identity, never order — order is the array's — so counting upwards costs nothing and keeps
     * the allocator monotonic, where reserving a block underneath would collide the moment two pages land. */
    prepend(rows: readonly TranscriptRow[]): void {
        const state = this.state.value;
        const older = rows.reduce((built, row) => appendMessage(built, row), { ...emptyTranscriptState, nextId: state.nextId });
        this.state.value = { ...state, messages: [...older.messages, ...state.messages], nextId: older.nextId };
    }

    // Replace the transcript with messages that keep the ids they already carry (the local mirror's), resuming
    // the allocator ABOVE them, otherwise the next notice would collide with a restored bubble.
    adopt(messages: readonly ChatMessage[]): void {
        this.state.value = { ...emptyTranscriptState, messages, nextId: Math.max(0, ...messages.map((message) => message.id)) + 1 };
    }
}
