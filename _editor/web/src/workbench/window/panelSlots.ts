import { onMounted, onUnmounted, type ShallowRef, shallowRef } from "vue";

// SLOTS: each publishes an empty element (`display: contents`) for the shell to lend a floating panel a place to sit,
// above the router, since a panel's lifetime is the window's, not the route's. It teleports into whichever slot is
// published, or the parking stage otherwise. Module refs, not props: publisher and consumer sit on opposite sides of
// the router outlet.

// allow(module-state): a DOM slot a mounted surface publishes for a panel to teleport into
export const chatSlot = shallowRef<HTMLElement | null>(null);
// Chat's full-window home, published by the /chat area; preferred over the column, but outranked by a pop-out.
// allow(module-state): a DOM slot a mounted surface publishes for a panel to teleport into
export const chatFullSlot = shallowRef<HTMLElement | null>(null);
// The quick bar's slot (ChatQuickBar), published only while the chat is parked: it takes the parking stage's place
// so the composer of a chat with nowhere to be is still on screen.
// allow(module-state): a DOM slot a mounted surface publishes for a panel to teleport into
export const chatBarSlot = shallowRef<HTMLElement | null>(null);
// Preview's full-area home, published by the /preview section; outranks the side panel's, so standing on /preview
// always shows it there.
// allow(module-state): a DOM slot a mounted surface publishes for a panel to teleport into
export const previewSlot = shallowRef<HTMLElement | null>(null);
// Preview's home beside the section, published by its tab in the side panel (shell/side/SidePreview.vue).
// allow(module-state): a DOM slot a mounted surface publishes for a panel to teleport into
export const sidePreviewSlot = shallowRef<HTMLElement | null>(null);
// allow(module-state): a DOM slot a mounted surface publishes for a panel to teleport into
export const terminalSlot = shallowRef<HTMLElement | null>(null);

/**
 * Publishes the element `element()` returns into `slot` for as long as the calling component is mounted. On unmount it
 * clears the slot only while the slot still holds that same element: a surface that mounts before the one it replaces
 * unmounts (a route swap, a remount on the same route) has already published its own, and must keep it. The element is
 * captured at mount, since by the time `onUnmounted` runs the template ref already reads `null`.
 */
export const publishSlot = (slot: ShallowRef<HTMLElement | null>, element: () => HTMLElement | null): void => {
    let mine: HTMLElement | null = null;
    onMounted(() => {
        mine = element();
        slot.value = mine;
    });
    onUnmounted(() => {
        if (mine !== null && slot.value === mine) {
            slot.value = null;
        }
    });
};
