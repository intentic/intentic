import { reactive, ref, type VNode } from "vue";
import { errorMessage } from "../useAsyncAction";
import { useAgents } from "./useAgents";

/* Inline title-edit state machine for one agent surface (fleet card, detail header). Per-instance factory —
 * each surface owns its editing/draft/error state; the actual write goes through useAgents().rename, which
 * handles the conversation/registry sync and optimistic revert. Returned reactive() so nested refs unwrap in
 * templates. Conventions match WorkspaceTree's inline rename: focus+select on mount, enter=commit, esc=cancel,
 * blur=commit, empty or unchanged = silent cancel. */

// Focus + select the input the moment it mounts (the @vue:mounted trick, see WorkspaceTree).
const focusInput = (vnode: VNode): void => {
    const el = vnode.el as HTMLInputElement;
    el.focus();
    el.select();
};

export const createTitleEdit = (agentId: () => string, current: () => string | undefined) => {
    const { rename } = useAgents();
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
            await rename(agentId(), trimmed);
        } catch (caught) {
            error.value = errorMessage(caught, `Couldn't rename the agent.`);
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
