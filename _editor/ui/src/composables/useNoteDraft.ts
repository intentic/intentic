import { computed, type ComputedRef, ref, type Ref, watch, type WritableComputedRef } from "vue";

/* AN EDITABLE MARKDOWN NOTE, the lifecycle, without the chrome.
 *
 * A pane that lets somebody read a note, correct it and delete it has the same six moving parts every time:
 * the draft, the one binding that shows the draft-or-the-file, the two writes, whether either is in flight,
 * whatever the last one said when it failed, and whether the delete has been confirmed. The knowledge and
 * memory panes had each written all six, forty lines apart and line-for-line alike, and the ways they had
 * already drifted are the argument for this being one function: one of them cleared the confirmation on the
 * error strip and the other did not, and NEITHER caught a failing write, the strip filled in from the
 * mutation's own error ref while the click handler's promise rejected into the console.
 *
 * THE DRAFT IS THE CALLER'S REF, not one made here, and that is the point of taking it rather than owning it:
 * an unsaved edit has to survive reading another note and coming back, so it lives in the VIEW above the pane,
 * which outlives the selection. `undefined` means "not editing", one piece of state for both, so an editor
 * can never be open with nothing in it.
 *
 * A FAILED WRITE KEEPS THE DRAFT. The words somebody typed are the one thing in here that cannot be fetched
 * again, so nothing is cleared until the write comes back successful.
 *
 * NOTHING FROM A DATA LIBRARY crosses this boundary: the writes arrive as two functions returning promises, so
 * the kit stays free of the query client the extensions happen to use, and a caller that fetches some other way
 * is not shut out. What it gives back, `saving`, `removing`, `error`, is what the pane's chrome binds to, so
 * a pane reads one source for "is this busy" rather than two that can disagree. */

export interface NoteDraftOptions {
    /** The in-progress edit, owned by the view above the pane. `undefined` means "not editing". */
    readonly draft: Ref<string | undefined>;
    /** The note as it stands on disk. */
    readonly raw: () => string;
    /** Write the draft. Rejecting is ordinary, the message lands in `error` and the draft is kept. */
    readonly save: (content: string) => Promise<unknown>;
    /** Delete the note. Same contract as `save`. */
    readonly remove: () => Promise<unknown>;
    /** Which note this is. Changing it drops the confirmation and the error, a question that expired and a
     *  complaint about a different file, but never the draft, which is the reader's unsaved words. */
    readonly note?: () => unknown;
    /** Ran when the note changes, for a pane with a view mode of its own to put back. */
    readonly onLeave?: () => void;
    /** Ran once the note is gone. The view owns the selection, so it decides what to show next. */
    readonly onRemoved?: () => void;
}

export interface NoteDraft {
    /** What the source surface shows and writes: the draft while one is open, the file otherwise. One binding
     *  for both, so reading the markdown and editing it cannot get out of step. */
    readonly source: WritableComputedRef<string>;
    /** Is a draft open, the one flag a pane's whole chrome keys off. */
    readonly editing: ComputedRef<boolean>;
    /** Is the delete confirmation showing. Writable: the pane's own trash button opens it. */
    readonly confirming: Ref<boolean>;
    /** What the last write said when it failed, cleared the moment another is attempted. */
    readonly error: Readonly<Ref<string | undefined>>;
    readonly saving: Readonly<Ref<boolean>>;
    readonly removing: Readonly<Ref<boolean>>;
    readonly startEdit: () => void;
    readonly cancelEdit: () => void;
    readonly saveDraft: () => Promise<void>;
    readonly forget: () => Promise<void>;
}

export function useNoteDraft({ draft, raw, save, remove, note, onLeave, onRemoved }: NoteDraftOptions): NoteDraft {
    const confirming = ref(false);
    const saving = ref(false);
    const removing = ref(false);
    const error = ref<string | undefined>(undefined);

    if (note !== undefined) {
        watch(
            note,
            () => {
                confirming.value = false;
                error.value = undefined;
                onLeave?.();
            },
            { deep: true },
        );
    }

    const source = computed<string>({
        get: () => draft.value ?? raw(),
        set: (next) => {
            draft.value = next;
        },
    });
    const editing = computed(() => draft.value !== undefined);

    // Both writes are the same shape, busy while it runs, the message if it does not land, and a second click
    // while one is in flight is a duplicate request, not a second intention.
    const attempt = async (busy: Ref<boolean>, work: () => Promise<unknown>): Promise<boolean> => {
        busy.value = true;
        error.value = undefined;
        try {
            await work();
            return true;
        } catch (cause) {
            error.value = cause instanceof Error ? cause.message : String(cause);
            return false;
        } finally {
            busy.value = false;
        }
    };

    const startEdit = (): void => {
        draft.value = raw();
    };
    const cancelEdit = (): void => {
        draft.value = undefined;
    };

    const saveDraft = async (): Promise<void> => {
        const content = draft.value;
        if (content === undefined || saving.value) {
            return;
        }
        if (await attempt(saving, () => save(content))) {
            draft.value = undefined;
        }
    };

    const forget = async (): Promise<void> => {
        if (removing.value || !(await attempt(removing, remove))) {
            return;
        }
        draft.value = undefined;
        confirming.value = false;
        onRemoved?.();
    };

    return { source, editing, confirming, error, saving, removing, startEdit, cancelEdit, saveDraft, forget };
}
