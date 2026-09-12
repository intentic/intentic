import { computed, type ComputedRef, watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { drawsChat, elsewhereStrip, publishStrip } from "../run/chatEcho";
import { chatRun } from "../run/chatRun";
import { type Strip, tabFacts } from "../tabs/tabFacts";
import { activeId, conversations, panes, scopedSandboxId } from "../tabs/useChat-tabs";

// Outside surfaces must read the owner's complete projection, never combine it with this window's shadow tabs.
const localStrip = computed<Strip>(() => ({
    active: activeId.value,
    panes: panes.value,
    tabs: conversations.value.map(tabFacts),
    run: chatRun.value,
}));

export const chatStrip: ComputedRef<Strip> = computed(() => (drawsChat.value ? localStrip.value : elsewhereStrip.value));

// Scope is part of the watch key even when two sandboxes happen to restore identical tab data.
watch(
    () => [scopedSandboxId.value, drawsChat.value ? JSON.stringify(localStrip.value) : undefined] as const,
    ([sandbox, json]) => {
        if (json !== undefined) {
            publishStrip(JSON.parse(json) as Strip, sandbox);
        }
    },
    { immediate: true },
);

// Singleton per window: a hot-reloaded rerun would publish a second, competing strip.
reloadOnHotUpdate(import.meta);
