// Where the Environment card's rebuild step is. "Rebuild needed" points here rather than at the page: its reader sat on
// the Environment tab for an hour without finding the rebuild, clicking the card's tabs and its refresh instead
// (2026-10-06). The card scrolls to it and focuses its button on arrival (EnvironmentCard.vue), and the switcher's
// followRow does the same for a click while the page is already open. A module of its own so the attention list can name
// it without importing the card.
export const REBUILD_ANCHOR = `sandbox-rebuild`;
