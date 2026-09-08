import type { TranscriptCards, TranscriptRow } from "@intentic/sandbox-contract";
import { computed, type ComputedRef, ref, shallowRef } from "vue";
import { recordPerf } from "../../../app/perf";
import type { ChatMessage } from "./transcript";
import { appendMessage, applyPatch, attachRun, emptyTranscriptState, flushPending, revealPending, type TranscriptState } from "./transcriptState";
import type { AttachEntry, AttachHead, TurnContext } from "../run/turnStream";

// The transcript as it's being written: state, the clock deciding when an entry shows, and every write to it, unified
// because buffering makes the writes non-independent, a notice appended without applying pending patches first would
// read as the agent still working. Row meaning is decided by the daemon; this owns only state, timing, and ordering.

// Runs on this window's own frames: a floating chat is its own window (composables/floating.ts), so the clock and the
// entries it drives always share one window's paint cycle.

// Bounds the lag when nothing is painting (a minimized window), so the clock doesn't stay armed forever.
const CLOCK_FALLBACK_MS = 120;

export class TranscriptClock {
    // shallowRef, not ref: transitions replace the whole object; nothing ever mutates through `state.value`.
    private readonly state = shallowRef<TranscriptState>(emptyTranscriptState);

    readonly messages: ComputedRef<readonly ChatMessage[]> = computed(() => this.state.value.messages);

    // No frame handle kept; an idle tick just returns. The fallback timer is held so it can't fire twice.
    private clockArmed = false;
    private clockFallback: ReturnType<typeof setTimeout> | undefined;

    // Whether this transcript is visible; unwatched, a batch settles whole rather than typing. Default true.
    readonly watched = ref(true);

    // Entries awaiting the next tick, paired with their turn since the buffer outlives any one stream.
    private readonly inbox: { readonly entry: AttachEntry; readonly turn: TurnContext; readonly replay: boolean }[] = [];

    // Runs the conversation's side effect per entry, in arrival order; told if it's a replay, so it applies once.
    constructor(private readonly applied: (entry: AttachEntry, turn: TurnContext, replay: boolean) => void) {}

    // Buffers for the next tick rather than applying immediately, so a burst costs one render, not one apiece. The
    // transition-to-consequence ordering is `tick`'s to keep exact.
    push(entry: AttachEntry, turn: TurnContext, replay = false): void {
        this.inbox.push({ entry, turn, replay });
        this.schedule();
    }

    // Runs a tick on the next paint, unless one is already owed. Only schedules while there's work, buffered entries or
    // pending text, so an idle conversation holds no timer.
    private schedule(): void {
        if (this.clockArmed) {
            return;
        }
        this.clockArmed = true;
        this.clockFallback = setTimeout(() => this.tick(), CLOCK_FALLBACK_MS);
        globalThis.requestAnimationFrame(() => this.tick());
    }

    // Applies the buffer to `from`, pure; the caller decides the ending, since a tick and a settle finish differently.
    // Order-dependent, so patches cannot be merged; this saves a render per entry, not a rebuild.
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

    // Hands a fold's entries to the conversation in arrival order, since state that spans entries (a provider_retry and
    // its answer) can land in one batch.
    private runApplied(applied: ReturnType<TranscriptClock[`foldInbox`]>[`applied`]): void {
        for (const { entry, turn, replay } of applied) {
            this.applied(entry, turn, replay);
        }
    }

    // One paint's work: apply entries that arrived since the last tick, then reveal the typewriter's next slice, in one
    // write to `state.value`.
    private tick(): void {
        this.clockArmed = false;
        clearTimeout(this.clockFallback);
        // Work may already be drained by a catchUp or settle; an empty tick is cheaper than cancellation bookkeeping.
        if (this.inbox.length === 0 && this.state.value.pending === undefined) {
            return;
        }
        // Measured by hand, not trackPerf: this runs every paint and can't afford a closure and a promise per tick.
        const from = performance.now();
        const { state, applied } = this.foldInbox(this.state.value);
        const folded = performance.now();
        // Reveals against the state the fold just produced, so one write carries both jobs (see `watched`).
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

    // Brings the transcript current off the clock, without disturbing the typewriter: still-revealing text keeps
    // revealing. User-clock writes call this first, so they can't overtake entries already arrived.
    catchUp(): void {
        const { state, applied } = this.foldInbox(this.state.value);
        this.state.value = state;
        this.runApplied(applied);
        if (this.state.value.pending !== undefined) {
            this.schedule();
        }
    }

    // Finishes the transcript: buffered entries applied, the typewriter drained not animated, in one write, so
    // downstream never reads a torn transcript. Applied even on abort, since they already arrived.
    settle(): void {
        const { state, applied } = this.foldInbox(this.state.value);
        this.state.value = flushPending(state);
        this.runApplied(applied);
    }

    // Applies buffered entries before `next`; otherwise a Stop's notice could land above patches that already arrived,
    // reading as the agent still working. Free when the buffer is already empty.
    write(next: (state: TranscriptState) => TranscriptState): void {
        this.catchUp();
        this.state.value = next(this.state.value);
    }

    // Stamps a user bubble's sentAt at append time, since append is when it was sent, unless the caller already set
    // one. Not in the transitions: rebuild/adopt pour whole transcripts through those and would re-stamp restored
    // messages.
    append(message: Omit<ChatMessage, "id">): number {
        const id = this.state.value.nextId;
        const stamped = message.role === `user` && message.sentAt === undefined ? { ...message, sentAt: Date.now() } : message;
        this.write((state) => appendMessage(state, stamped));
        return id;
    }

    // Muted line written on the user's clock; local, since a fork must exclude only rows this window drew.
    notice(text: string, extra?: Pick<ChatMessage, "noticeAction" | "noticeWait">): number {
        return this.append({ role: `notice`, text, local: true, ...extra });
    }

    // Freezes a card the instant the daemon accepts it, closing the gap before the matching `resolved` patch arrives,
    // so its buttons aren't offered a second time.
    attachCard(id: number, cards: TranscriptCards): void {
        this.write((state) => ({
            ...state,
            messages: state.messages.map((message) => (message.id === id ? { ...message, ...cards } : message)),
        }));
    }

    // Flushes the buffer first, so a patch from an earlier attach can't land on rows that just replaced its target.
    // `drawn` is the bubble this window drew ahead of the head, replaced in place.
    attachRun(head: AttachHead, drawn?: number): { readonly base: number; readonly userMessageId: number | undefined } {
        this.catchUp();
        const next = attachRun(this.state.value, head, drawn);
        this.state.value = next;
        const base = next.attached?.base ?? next.messages.length;
        return { base, userMessageId: next.messages.slice(base).find((message) => message.role === `user`)?.id };
    }

    // A refused turn produced nothing, so leaving its bubble would read as said-and-answered when the agent never saw
    // it, and a later attach would show it twice.
    takeBackUserBubble(userMessageId: number): ChatMessage | undefined {
        const index = this.messages.value.findIndex((message) => message.id === userMessageId);
        const bubble = this.messages.value[index];
        if (bubble === undefined || bubble.role !== `user`) {
            return undefined;
        }
        this.state.value = { ...this.state.value, messages: this.state.value.messages.filter((message) => message.id !== userMessageId) };
        return bubble;
    }

    // Replaces the transcript with rows that carry no ids of their own (a branch's inherited turns, the daemon's
    // record), allocating fresh ones. Nothing stays attached afterward.
    rebuild(rows: readonly TranscriptRow[]): void {
        this.state.value = rows.reduce((state, row) => appendMessage(state, row), emptyTranscriptState);
    }

    // Puts an older page above what's drawn; every standing message keeps its id and position, safe mid-stream. New ids
    // allocate above the current high-water mark, keeping the allocator monotonic and collision-free.
    prepend(rows: readonly TranscriptRow[]): void {
        const state = this.state.value;
        const older = rows.reduce((built, row) => appendMessage(built, row), { ...emptyTranscriptState, nextId: state.nextId });
        this.state.value = { ...state, messages: [...older.messages, ...state.messages], nextId: older.nextId };
    }

    // Keeps existing ids from the local mirror; the allocator resumes above them so a notice can't collide.
    adopt(messages: readonly ChatMessage[]): void {
        this.state.value = { ...emptyTranscriptState, messages, nextId: Math.max(0, ...messages.map((message) => message.id)) + 1 };
    }
}
