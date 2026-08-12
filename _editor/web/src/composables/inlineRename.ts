import { reactive, ref, type VNode } from "vue";
import { errorMessage } from "@intentic/ui/async";

/* THE APP'S ONE INLINE-RENAME STATE MACHINE — a name that reads as text until it is clicked. Per-instance
 * factory; each surface owns its editing/draft/error state. Returned reactive() so nested refs unwrap in
 * templates. Conventions match WorkspaceTree's inline rename, which is where they were set: focus+select on
 * mount, enter=commit, esc=cancel, blur=commit, empty or unchanged = silent cancel.
 *
 * WHAT IT WRITES IS THE CALLER'S, which is the whole reason this is not in `composables/agents/` any more. It
 * was written for the fleet card and reached into useAgents().rename itself, so the four agent surfaces shared
 * one state machine and anything else that wanted a click-to-rename name had to grow a second copy of it. The
 * personas list is the first such surface, and a name whose editing rules differ from every other name in the
 * app by a keystroke is precisely the kind of drift a shared factory exists to prevent. */

// Focus + select the input the moment it mounts (the @vue:mounted trick, see WorkspaceTree).
const focusInput = (vnode: VNode): void => {
    const el = vnode.el as HTMLInputElement;
    el.focus();
    el.select();
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
    // Blur fires before the click that caused it: a blur-commit must not ALSO activate what was clicked (the
    // card body would open the agent). Consumed by the surface's open handler; self-clears for keyboard blurs.
    let suppressOpen = false;

    const begin = (): void => {
        if (busy.value) {
            return; // a rename is in flight; racing it would fight the optimistic revert
        }
        draft.value = current() ?? ``;
        error.value = undefined;
        editing.value = true;
    };
    const cancel = (): void => {
        editing.value = false;
    };
    const commit = async (): Promise<void> => {
        if (!editing.value) {
            return; // enter already committed; the input's unmount blur must not commit again
        }
        editing.value = false;
        const trimmed = draft.value.trim();
        if (trimmed === `` || trimmed === (current() ?? ``)) {
            return; // silent cancel, the WorkspaceTree convention
        }
        busy.value = true;
        try {
            await write(trimmed);
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
