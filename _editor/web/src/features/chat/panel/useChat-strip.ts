import { computed, type ComputedRef, watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { drawsChat, elsewhereStrip, publishStrip } from "../run/chatEcho";
import { type Strip, tabFacts } from "../tabs/tabFacts";
import { activeId, conversations, panes } from "../tabs/useChat-tabs";

/* THE STRIP AS EVERYTHING OUTSIDE THE PANEL READS IT (tabFacts.ts): every open tab as a card would draw it, the
 * focus, the panes. This window's own while it draws the chat; the drawing window's published one while it does
 * not (chatEcho.ts). It is the ONE account of the chat the fleet board, the ring and every other surface outside
 * the panel consult, and the reason none of them has to know which window the chat is in: the choice between a
 * local tab and an echo is made here, once, and nowhere else. */
const localStrip = computed<Strip>(() => ({
    active: activeId.value,
    panes: panes.value,
    tabs: conversations.value.map(tabFacts),
}));

export const chatStrip: ComputedRef<Strip> = computed(() => (drawsChat.value ? localStrip.value : elsewhereStrip.value));

/* ...and told to the windows that are NOT drawing it. A stringified getter, like the snapshot above: a card's
 * facts stop changing once its first line is typed (the preview is cut short, the stamp only moves on the edge
 * into unsent), so keystrokes publish nothing after the first few. Gated on drawing the panel, since a window
 * that isn't is repeating hearsay, and the gate is IN the key so that becoming the drawing window publishes at
 * once rather than at the next change. Parsed back rather than handed the live object so what the local reader
 * and the remote one hold is byte for byte the same strip. */
watch(
    () => (drawsChat.value ? JSON.stringify(localStrip.value) : undefined),
    (json) => {
        if (json !== undefined) {
            publishStrip(JSON.parse(json) as Strip);
        }
    },
    { immediate: true },
);

// A singleton per window (hotReload.ts): a hot update that re-ran this module would publish a second strip
// beside the one the rest of the app still reads.
reloadOnHotUpdate(import.meta);
