import { watch } from "vue";
import { useAgents } from "../composables/agents/useAgents";
import { postToHost } from "./hostBridge";

/* "AN AGENT NEEDS YOU", TOLD TO THE HOST — the local posture's version of the moment this product exists
 * for. In the browser app the attention count is always on screen (the rail badges it); in a host, the panel
 * is usually hidden behind the editor's own work, so the host renders the fact its own way — a badge on the
 * activity bar, a notification. The count is the fleet's OWN attention projection (useAgents: blocked turns,
 * unread finishes, held wakes), so the host's badge and the board can never disagree. Posted on every change
 * INCLUDING zero, which is what lets the host clear. */

export const watchHostAttention = (): void => {
    const { attention } = useAgents();
    watch(
        attention,
        (count, previous) => {
            if (count !== previous) {
                postToHost({ type: "intentic:attention", count });
            }
        },
        { immediate: true },
    );
};
