import { nextTick, reactive, ref, type VNode } from "vue";
import { errorMessage } from "./useAsyncAction.js";

// The state behind <InlineRename>: a name that reads as text until it is pressed. Per-instance factory, returned
// reactive() so refs unwrap in templates; what a commit writes is left to the caller. Conventions: focus+select on
// mount, enter=commit, esc=cancel, blur=commit, empty or unchanged = silent cancel, and a FAILED write keeps the
// field open with the typed name still in it, since throwing the draft away is the one thing the user cannot undo.

// Focus and select the input the moment it mounts (the @vue:mounted trick). The selection waits a tick because
// v-model writes the value in its OWN mounted hook, which runs after this one: selecting before that selects the
// empty string, and the caret then lands after the name instead of over it.
const focusInput = (vnode: VNode): void => {
    const el = vnode.el as HTMLInputElement;
    el.focus();
    void nextTick(() => el.select());
};

export const createInlineRename = (
    /** The name as it stands, read at the moment editing begins and again to spot an unchanged commit. */
    current: () => string | undefined,
    /** Where a committed name goes. Throwing is how it reports failure; the message lands on `error`. */
    write: (name: string) => Promise<void>,
    /** What to say when the write fails, in the words of whatever is being renamed. */
    failure = `Couldn't rename this.`,
) => {
    const editing = ref(false);
    const draft = ref(``);
    const busy = ref(false);
    const error = ref<string | undefined>(undefined);
    // Blur fires before its click; suppresses that click's open handler, self-clearing for keyboard blurs.
    let suppressOpen = false;

    const begin = (): void => {
        if (busy.value) {
            return; // A rename is in flight; racing it would fight the write it is waiting on.
        }
        draft.value = current() ?? ``;
        error.value = undefined;
        editing.value = true;
    };
    const cancel = (): void => {
        editing.value = false;
        error.value = undefined;
    };
    const commit = async (): Promise<void> => {
        if (!editing.value || busy.value) {
            return; // Enter already started this write; the unmount blur must not start a second one.
        }
        const trimmed = draft.value.trim();
        if (trimmed === `` || trimmed === (current() ?? ``)) {
            editing.value = false;
            error.value = undefined;
            return; // Silent cancel: empty or unchanged, nothing to write.
        }
        busy.value = true;
        error.value = undefined;
        try {
            await write(trimmed);
            editing.value = false;
        } catch (caught) {
            error.value = errorMessage(caught, failure);
        } finally {
            busy.value = false;
        }
    };
    const blurCommit = (): void => {
        suppressOpen = true;
        setTimeout(() => (suppressOpen = false), 0);
        void commit();
    };
    const consumeSuppressedOpen = (): boolean => {
        const suppressed = suppressOpen;
        suppressOpen = false;
        return suppressed;
    };

    return reactive({ editing, draft, busy, error, begin, cancel, commit, blurCommit, consumeSuppressedOpen, focusInput });
};

export type InlineRenameControl = ReturnType<typeof createInlineRename>;
