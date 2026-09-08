import { computed, type ComputedRef, ref, type Ref, watch, type WritableComputedRef } from "vue";

// An editable markdown note's lifecycle without the chrome: draft, a file-or-draft binding, two writes,
// busy flags, the last error, delete confirmation. The draft is the caller's own ref, since an unsaved
// edit must survive switching notes and back; `undefined` means not editing. A failed write keeps the
// draft, the one thing here that can't be re-fetched.

export interface NoteDraftOptions {
    /** The in-progress edit, owned by the view above the pane. `undefined` means not editing. */
    readonly draft: Ref<string | undefined>;
    /** The note as it stands on disk. */
    readonly raw: () => string;
    /** Write the draft. Rejecting is ordinary: the message lands in `error` and the draft is kept. */
    readonly save: (content: string) => Promise<unknown>;
    /** Delete the note. Same contract as `save`. */
    readonly remove: () => Promise<unknown>;
    /** Which note this is; changing it drops the confirmation and error, never the reader's unsaved draft. */
    readonly note?: () => unknown;
    /** Ran when the note changes, for a pane with a view mode of its own to reset. */
    readonly onLeave?: () => void;
    /** Ran once the note is gone; the view owns the selection and decides what to show next. */
    readonly onRemoved?: () => void;
}

export interface NoteDraft {
    /** What the surface shows and writes: the draft while open, the file otherwise; one binding for both. */
    readonly source: WritableComputedRef<string>;
    /** Whether a draft is open, the one flag a pane's whole chrome keys off. */
    readonly editing: ComputedRef<boolean>;
    /** Whether the delete confirmation is showing; writable, so the pane's own trash button opens it. */
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

    // Both writes are the same shape: busy while running, message on failure, no-op on re-entry.
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
