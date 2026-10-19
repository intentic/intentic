import { computed } from "vue";
import { chatInSidePanel } from "../../models/conversations/panel/chatPanelLayout";
import { useSidePanel } from "../../workbench/side/sideTabs";
import { shownSideTabs } from "../../workbench/side/sideViews";
import { reviewFocused } from "../../workbench/window/reviewFocus";

// HOW THE SHELL LAYS OUT WHAT WAS OPENED BESIDE A SIDE-DOCKED CHAT, read by the shell's grid and the side panel alike.
// Opening something beside the chat means the reader wants to look at it now, so it takes the whole middle: in a column
// sized for a chat, code wraps on every line and a preview shrinks to a phone. The section the rail picked stays mounted
// under it, hidden, and comes back beside it (split) the moment the reader goes to a section or asks for it.

const panel = useSidePanel();

// Tabs on screen and the chat beside them, rather than the tabs alone in the chat's column (the chat on the rail).
export const besideChat = computed(() => chatInSidePanel.value && shownSideTabs.value.length > 0);
// What was opened covers the main area, from the rail to the chat.
export const besideFills = computed(() => besideChat.value && !panel.split.value);

// The side panel takes its column while it holds anything: the chat whose home is the side, or what was opened beside
// the section. Empty, the column is 0 wide. Holding both, what was opened fills the middle, the panel spanning the
// section's cell too, or, split, the column is wide enough for the two side by side.
export const sideShown = computed(() => chatInSidePanel.value || shownSideTabs.value.length > 0);
// Focus review (reviewFocus.ts) gives the section the panel's column too: the panel stays mounted, only hidden.
export const sideColumnShown = computed(() => sideShown.value && !reviewFocused.value);
