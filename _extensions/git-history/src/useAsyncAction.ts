import { ref } from "vue";

/* The one shape every user-facing mutation in this extension reports through: a busy flag + a surfaced error
 * line. Errors are SURFACED, not thrown — a refused git call (an unmerged branch, a dirty worktree) is an
 * ordinary answer the panel has to show, not something that should blow up the DOM handler that fired it.
 * Re-entry while busy is a no-op, so a double-click cannot fire a git write twice. */

// The thrown thing's user-facing message: Error instances and message-carrying objects (the host's transport
// errors) speak for themselves; anything else — or an empty message — falls back to the caller's phrasing.
export const errorMessage = (error: unknown, fallback: string): string =>
    typeof error === `object` && error !== null && `message` in error && typeof error.message === `string` && error.message !== ``
        ? error.message
        : fallback;

export function useAsyncAction() {
    const busy = ref(false);
    const error = ref<string | undefined>(undefined);
    const run = async (task: () => Promise<void>, failMessage = `Action failed.`): Promise<void> => {
        if (busy.value) {
            return;
        }
        error.value = undefined;
        busy.value = true;
        try {
            await task();
        } catch (caught) {
            error.value = errorMessage(caught, failMessage);
        } finally {
            busy.value = false;
        }
    };
    return { busy, error, run };
}
