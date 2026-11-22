import { computed, ref, watch } from "vue";
import { chatInSidePanel } from "../../models/conversations/panel/chatPanelLayout";
import { sandboxBeside } from "../../models/home/masterRail";
import { forgetInsistence, useSidePanel } from "../../workbench/side/sideTabs";
import { shownSideTabs } from "../../workbench/side/sideViews";
import { reviewFocused } from "../../workbench/window/reviewFocus";
import { MIN_PANE_PX, roomBesideChat } from "../../workbench/window/useLayout";

// HOW THE SHELL LAYS OUT WHAT WAS OPENED BESIDE A SIDE-DOCKED CHAT, read by the shell's grid and the side panel alike.
// Opening something beside the chat means the reader wants to look at it now, so it takes the whole middle: in a column
// sized for a chat, code wraps on every line and a preview shrinks to a phone. The section the rail picked stays mounted
// under it, hidden, and comes back beside it (split) the moment the reader goes to a section or asks for it.

const panel = useSidePanel();

// Tabs on screen and the chat beside them, rather than the tabs alone in the chat's column (the chat on the rail).
export const besideChat = computed(() => chatInSidePanel.value && shownSideTabs.value.length > 0);

// TUCKED AWAY: what was opened folds into a strip of its tabs' icons at the column's edge (SideTucked.vue), beside the chat
// or at the window's edge, every body still mounted under it. The reader tucks it (dragging the column's edge past half a
// pane, or its Tuck away button), and so does a window too narrow to give it a pane beside the chat. That one undoes
// itself when the window widens again; the reader's own tuck stays until they bring it back.
export const TUCKED_STRIP_PX = 32;
// Dragged narrower than this, the column tucks away; the same distance past the floor as filling the middle is past the
// section's (SidePanel.vue).
export const TUCK_BELOW_PX = MIN_PANE_PX / 2;

// allow(module-state): the window's own width, which no sandbox switch changes
const windowWidth = ref(globalThis.innerWidth ?? 0);
globalThis.addEventListener?.(`resize`, () => {
    windowWidth.value = globalThis.innerWidth;
});
const squeezed = computed(() => besideChat.value && roomBesideChat(windowWidth.value) < MIN_PANE_PX);
// Each narrowing tucks it again, whatever the reader asked for while the window was wide.
watch(squeezed, (now) => now && forgetInsistence());

export const sideTucked = computed(() => shownSideTabs.value.length > 0 && (panel.tucked.value || (squeezed.value && !panel.insisted.value)));

// What was opened covers the main area, from the rail to the chat.
export const besideFills = computed(() => besideChat.value && !panel.split.value && !sideTucked.value);

// The side panel takes its column while it holds anything: the chat whose home is the side, or what was opened beside
// the section. Empty, the column is 0 wide. Holding both, what was opened fills the middle, the panel spanning the
// section's cell too, or, split, the column is wide enough for the two side by side.
// The column is the sandbox's, wherever a page of it is on screen, the rail folded or unrolled (models/home/masterRail.ts
// `sandboxBeside`). Home's own page has its one chat as its page.
export const sideShown = computed(() => sandboxBeside.value && (chatInSidePanel.value || shownSideTabs.value.length > 0));
// Focus review (reviewFocus.ts) gives the section the panel's column too: the panel stays mounted, only hidden.
export const sideColumnShown = computed(() => sideShown.value && !reviewFocused.value);
