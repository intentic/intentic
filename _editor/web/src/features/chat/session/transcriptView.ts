import { type EditorContext, isAwaitingDecision, type TranscriptRow } from "@intentic/sandbox-contract";
import { basename } from "@intentic/ui/path";
import { computed, ref, type Ref } from "vue";
import { trackPerf } from "../../../app/perf";
import { uuid } from "../../../lib/uuid";
import { orRefusal, SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import type { SessionRef } from "../run/turnRequest";
import type { AttachEntry, TurnContext } from "../run/turnStream";
import { olderTranscriptPage } from "../transcript/agentTranscript";
import { type ChatAttachment, type ChatMessage, recordedRows, withCancelledCards } from "../transcript/transcript";
import { readTranscript, saveTranscript } from "../transcript/transcriptCache";
import { TranscriptClock } from "../transcript/transcriptClock";
import type { PendingAttachment } from "../drafts/useChatAttachments";
import type { TurnClient } from "./turnClient";

// One conversation's transcript as a reader sees it: the rows and their clock (TranscriptClock), the pages above them,
// the local mirror a reopened tab paints from, and the three ways back into it — fork, rewind, edit. What a turn's
// entries mean beyond the rows is the conversation's (`applied`); this unit never starts a turn of its own.

// Why the daemon would not go back, by its answer: a turn holds the conversation, or the message clicked is no longer
// where it was, since another window rewound or a turn ran after this one read it; anything else, no saved state.
const rewindRefusal = (status: number): string => {
    if (status === 409) {
        return `This agent is running a turn, stop it before going back.`;
    }
    return status === 412 ? `This conversation has moved on since you opened it: reload it and try again.` : `That message can no longer be gone back to.`;
};

// What an edit and a rewind need from the conversation around the transcript.
export interface TranscriptHost {
    readonly conversationId: string;
    // The box every read and write here is aimed at; undefined for the active sandbox.
    readonly box: Ref<string | undefined>;
    // The composer an armed edit borrows and hands back.
    readonly draft: Ref<string>;
    readonly attachments: Ref<PendingAttachment[]>;
    // The conversation's red line, which a refused rewind or place writes, and a redraw clears.
    readonly error: Ref<string | null>;
    // The session a rewind or a place retires: the next turn opens a fresh one.
    readonly session: Ref<SessionRef | undefined>;
    // The runs: a live one a mirror must never paint over, and the send an edit makes once its rewind has landed.
    readonly turn: Pick<TurnClient, "streaming" | "say">;
}

export class TranscriptView extends TranscriptClock {
    // True while a transcript read is in flight and nothing is painted, so the panel shows loading instead.
    readonly loading = ref(false);
    // Position of the oldest drawn message, and whether more sits above it; passed back as `before` to page further.
    readonly historyFrom = ref(0);
    readonly historyMore = ref(false);
    // A page of older turns is loading; unlike `loading`, which blanks the whole transcript instead of appending.
    readonly loadingOlder = ref(false);

    // True while a turn is parked on a card; the turn still streams, but the composer shows Send, not Stop.
    readonly awaitingDecision = computed(() => this.messages.value.some(isAwaitingDecision));

    // Message carrying a plan awaiting decision, if any; routes feedback into a plan rejection instead of a fresh turn.
    readonly pendingPlanMessage = computed(() => this.messages.value.find((message) => message.plan?.status === `pending`));

    // Lifetime accounting summed off the rows on screen; the daemon's registry is the cross-device authoritative total.
    readonly costUsd = computed(() => this.messages.value.reduce((sum, message) => sum + (message.usage?.costUsd ?? 0), 0));
    readonly inputTokens = computed(() => this.messages.value.reduce((sum, message) => sum + (message.usage?.inputTokens ?? 0), 0));
    readonly outputTokens = computed(() => this.messages.value.reduce((sum, message) => sum + (message.usage?.outputTokens ?? 0), 0));

    // Message being re-asked, keyed by id; disarmed by any transcript replacement, since ids repeat across transcripts.
    readonly editing = ref<{ readonly id: number; readonly restore: string; readonly attachments: readonly PendingAttachment[] } | undefined>();

    // `applied` hears every entry after its rows landed, in arrival order (TranscriptClock).
    constructor(
        applied: (entry: AttachEntry, turn: TurnContext, replay: boolean) => void,
        private readonly host: TranscriptHost,
    ) {
        super(applied);
    }

    // Replaces one notice's words in place, so a wait and its outcome are one row rather than two.
    rewordNotice(noticeId: number, text: string, extra?: Pick<ChatMessage, "noticeWait">): void {
        this.write((state) => ({
            ...state,
            messages: state.messages.map((message) => (message.id === noticeId ? { ...message, text, ...extra } : message)),
        }));
    }

    // Mirror the settled transcript locally so reopening paints from disk rather than waiting on the sandbox.
    // `authoritative` is the daemon's own replay, which may shrink the mirror; anything else is this window's view.
    persist(authoritative = false): void {
        // Timed: an unconfirmed write reads the mirror back first, so this is two IndexedDB writes per boundary.
        void trackPerf(`chat.persist`, { messages: this.messages.value.length, authoritative }, () =>
            saveTranscript(this.host.conversationId, this.messages.value, authoritative),
        );
    }

    // Paint the locally cached transcript if there is one and nothing has rendered yet; returns whether it painted.
    // The daemon still reconciles and replaces this: a stale mirror costs a repaint and nothing more.
    async paintCached(): Promise<boolean> {
        if (this.messages.value.length > 0 || this.host.turn.streaming.value) {
            return false;
        }
        const cached = await readTranscript(this.host.conversationId);
        // Re-checked after the await: a turn or reattach may have landed meanwhile; the live transcript always wins.
        if (cached === undefined || this.messages.value.length > 0 || this.host.turn.streaming.value) {
            return false;
        }
        this.adopt(cached);
        return true;
    }

    // Redraw the rows of a transcript the daemon replayed, leaving every other conversation property alone; a restored
    // tab already carries its own session, title, provider, and isolation from the tab snapshot.
    restoreMessages(messages: readonly TranscriptRow[], page?: { readonly from: number; readonly more: boolean }): void {
        // A replayed record wears the same ids on different messages; an edit armed against the old one fails.
        this.editing.value = undefined;
        this.rebuild(messages);
        // The cursor moves with the redraw: a caller with no page to report leaves it at "this is all of it".
        this.historyFrom.value = page?.from ?? 0;
        this.historyMore.value = page?.more ?? false;
        this.host.error.value = null;
        this.persist(true);
    }

    // Page above what's drawn, for a reader at the top; rows are prepended, never rebuilt, so a live turn survives.
    // Not persisted locally: paging a long conversation would mirror the whole record to disk, page by page.
    async loadOlder(): Promise<void> {
        if (this.loadingOlder.value || !this.historyMore.value || this.historyFrom.value <= 0) {
            return;
        }
        this.loadingOlder.value = true;
        try {
            const page = await olderTranscriptPage(this.host.conversationId, this.historyFrom.value, this.host.box.value);
            if (page === `gone` || page.messages.length === 0) {
                // Nothing above after all: stop offering, rather than leaving a button that answers with nothing.
                this.historyMore.value = false;
                return;
            }
            this.prepend(page.messages);
            this.historyFrom.value = page.from;
            this.historyMore.value = page.more;
        } catch {
            // A tunnel hiccup on a manual read; the transcript is untouched, so retrying is the same press again.
        } finally {
            this.loadingOlder.value = false;
        }
    }

    // The rows above `index` of another transcript, as this one's opening; how many of them the daemon's record holds,
    // since rows this window drew locally are not the source's to copy.
    cutFrom(source: TranscriptView, index: number): number {
        const kept = source.messages.value.slice(0, index);
        this.rebuild(kept);
        return recordedRows(kept);
    }

    // Go back to a message: the daemon restores the checkpoint, drops later messages, and forgets the session.
    // `message.rewindIndex` addresses the daemon's transcript; the slice below is over the bubbles, with local notices.
    async rewindTo(message: ChatMessage, reason: "rewind" | "edit" = `rewind`): Promise<boolean> {
        const { rewindIndex: index, messageId } = message;
        const bubble = this.messages.value.indexOf(message);
        if (index === undefined || messageId === undefined || bubble < 0) {
            return false;
        }
        const rewound = await orRefusal(
            sandboxRpc.agent.rewind({ conversationId: this.host.conversationId, index, messageId }, { context: { at: this.host.box.value } }),
        );
        if (rewound instanceof SandboxHttpError) {
            this.host.error.value = rewindRefusal(rewound.status);
            return false;
        }
        const dropped = this.messages.value.length - bubble;
        // The rebuild renumbers every bubble from zero, so an edit armed on one points elsewhere; disarmed here.
        this.editing.value = undefined;
        this.rebuild(this.messages.value.slice(0, bubble));
        // Says what happened to the files, since a rewind changes the workspace with nothing else on screen showing it.
        // An edit says so in its own words, naming what the prompt replaced; a plain rewind keeps its own wording.
        this.notice(
            reason === `edit`
                ? `Edited this message, ${dropped} message${dropped === 1 ? `` : `s`} dropped and the files restored to this point.`
                : `Went back to here, ${dropped} message${dropped === 1 ? `` : `s`} dropped and the files restored to this point.`,
        );
        this.host.session.value = undefined;
        this.host.error.value = null;
        this.persist(true);
        return true;
    }

    // Aim the composer at a message already sent; nothing is destroyed or sent here (see `editing`).
    // Refused with no checkpoint: an edit whose files can't go back would reason about a workspace never produced.
    beginEdit(message: ChatMessage): boolean {
        if (message.role !== `user` || message.rewindIndex === undefined || !this.messages.value.includes(message)) {
            return false;
        }
        this.editing.value = { id: message.id, restore: this.host.draft.value, attachments: this.host.attachments.value };
        this.host.draft.value = message.text;
        // The prompt's own files come back with it, already on disk, re-staged as finished chips with no `previewUrl`.
        this.host.attachments.value = (message.attachments ?? []).map((path): PendingAttachment => ({
            id: uuid(),
            name: basename(path),
            path,
            status: `done`,
            progress: 100,
        }));
        return true;
    }

    // Put draft and chips back to exactly what they were before the pencil; re-staged chips are not revoked, their
    // preview URLs still belong to the bubble on screen.
    cancelEdit(): void {
        const edit = this.editing.value;
        if (edit === undefined) {
            return;
        }
        this.host.draft.value = edit.restore;
        this.host.attachments.value = [...edit.attachments];
        this.editing.value = undefined;
    }

    // Spend the edit: rewind first, send only if it landed, since sending against unrewound files hits the wrong files.
    // The mode clears between the two, so the send appends to a transcript no longer drawing anything as doomed.
    async submitEdit(text: string, attachments: readonly ChatAttachment[] = [], editorContext?: EditorContext): Promise<boolean> {
        const edit = this.editing.value;
        if (edit === undefined) {
            return false;
        }
        const message = this.messages.value.find((candidate) => candidate.id === edit.id);
        if (message === undefined) {
            // The row left the transcript under an open editor; nothing to edit, so the mode just ends.
            this.editing.value = undefined;
            this.host.error.value = `That message is no longer in this conversation.`;
            return false;
        }
        if (!(await this.rewindTo(message, `edit`))) {
            return false;
        }
        this.editing.value = undefined;
        await this.host.turn.say(text, attachments, editorContext);
        return true;
    }

    // Place words into the transcript as an assistant bubble, with no turn or reply; the daemon marks the row `placed`.
    // In a channel conversation the daemon carries the line out first, so a refusal here can mean it was unreachable.
    async placeAsAgent(text: string): Promise<boolean> {
        const placed = await orRefusal(sandboxRpc.agents.place({ id: this.host.conversationId, text }, { context: { at: this.host.box.value } }));
        if (placed instanceof SandboxHttpError) {
            this.host.error.value =
                placed.status === 409
                    ? `This agent is running a turn: wait for it to finish before speaking as it.`
                    : placed.status === 404
                      ? `Could not place the message: this conversation hasn't run a turn yet.`
                      : `Could not place the message, ${placed.message}`;
            return false;
        }
        this.append({ role: `assistant`, text, placed: true });
        this.host.session.value = undefined;
        this.host.error.value = null;
        this.persist(true);
        return true;
    }

    // The files moved under this conversation without it doing anything: a checkpoint was restored mid-chat.
    // Only a notice, not a truncation: the transcript is intact, only the disk moved.
    noteWorkspaceRestored(): void {
        this.notice(`The workspace was restored to an earlier point, the files below this line have changed.`);
        this.persist(true);
    }

    // Freeze whatever a stopped turn was parked on, so a cancelled card doesn't leave `awaitingDecision` wedged on a
    // turn that no longer exists.
    cancelPendingCards(): void {
        if (!this.awaitingDecision.value) {
            return;
        }
        this.write((state) => ({ ...state, messages: state.messages.map(withCancelledCards) }));
    }
}
