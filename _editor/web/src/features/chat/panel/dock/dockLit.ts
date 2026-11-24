import { computed, type ComputedRef } from "vue";
import { useAskDock } from "../asks/askDock";

/**
 * Whether a line of the dock that is not an ask may light its press. One bright press to a surface, and while the agent
 * waits on the reader for something, that is the ask's: a land, a commit or a push beside it stays a plain press.
 */
export const useDockLit = (): ComputedRef<boolean> => {
    const dock = useAskDock();
    return computed(() => (dock?.asks.value.length ?? 0) === 0);
};
