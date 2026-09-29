// Where the update card's own button is. Both of the chip's update notes point here rather than at the page, so a reader
// already on the page is taken to the button instead of going nowhere (SandboxSwitcher's followRow). A module of its
// own so the card can name it without importing the attention list's whole graph.
export const UPDATE_ACTION_ANCHOR = `sandbox-update-action`;
