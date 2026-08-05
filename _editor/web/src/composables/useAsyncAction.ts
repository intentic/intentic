import { ref } from "vue";

/* The one shape every user-facing mutation reports through: a busy flag + a surfaced error line. Errors are
 * surfaced, not thrown — a failed daemon call (denylist 404, escape 400, oversize 413) shouldn't blow up the
 * DOM handler that fired it. Re-entry while busy is a no-op, so a double-click can't fire an action twice. */

// The thrown thing's user-facing message: Error instances and message-carrying objects (oRPC client errors)
// speak for themselves; anything else — or an empty message — falls back to the caller's phrasing.
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
