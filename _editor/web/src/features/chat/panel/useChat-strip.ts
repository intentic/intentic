import { computed, type ComputedRef, watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { drawsChat, elsewhereStrip, publishStrip } from "../run/chatEcho";
import { type Strip, tabFacts } from "../tabs/tabFacts";
import { activeId, conversations, panes } from "../tabs/useChat-tabs";

// The strip as everything outside the panel reads it: local while this window draws the chat, the drawing window's
// published echo otherwise. The one account every outside surface consults, so none needs to know which window holds
// the chat.
const localStrip = computed<Strip>(() => ({
    active: activeId.value,
    panes: panes.value,
    tabs: conversations.value.map(tabFacts),
}));

export const chatStrip: ComputedRef<Strip> = computed(() => (drawsChat.value ? localStrip.value : elsewhereStrip.value));

// Publishes the strip to windows not drawing the chat. Gated on drawing (and in the key, so becoming the drawing window
// publishes immediately); parsed back from JSON so every window holds byte-identical data.
watch(
    () => (drawsChat.value ? JSON.stringify(localStrip.value) : undefined),
    (json) => {
        if (json !== undefined) {
            publishStrip(JSON.parse(json) as Strip);
        }
    },
    { immediate: true },
);

// Singleton per window: a hot-reloaded rerun would publish a second, competing strip.
reloadOnHotUpdate(import.meta);
