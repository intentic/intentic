import { shallowRef } from "vue";

// Publishes an empty slot (`display: contents`) for the shell to lend a floating panel a place to sit, above the
// router, since a panel's lifetime is the window's, not the route's. It teleports into whichever slot is
// published, or the parking stage otherwise. Module refs, not props: publisher and consumer sit on opposite sides of
// the router outlet.

export const chatDock = shallowRef<HTMLElement | null>(null);
// Chat's full-window home, published by the /chat area; preferred over the column, but outranked by a pop-out.
export const chatFullDock = shallowRef<HTMLElement | null>(null);
// The bottom strip's slot (ChatQuickBar), published only while the chat is parked: it takes the parking stage's place
// so the composer of a chat with nowhere to be is still on screen.
export const chatBarDock = shallowRef<HTMLElement | null>(null);
// Preview's only in-shell home; no side-column slot, so it fills this area, floats, or waits parked.
export const previewDock = shallowRef<HTMLElement | null>(null);
export const terminalDock = shallowRef<HTMLElement | null>(null);
