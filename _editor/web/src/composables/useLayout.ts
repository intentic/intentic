import { ref, type Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";
import { activeSandboxId } from "./sandbox/activeSandbox";
import { iconRailScreenPx, useIconRailSize } from "./useIconRailSize";
import { toAppPx } from "./uiScale";
import { readWindowState, writeWindowState } from "./windowStore";

export type ChatPosition = "left" | "right";
// Which HOME the chat lives in: the side column beside every view, or behind a rail tile as the full-screen
// /chat area. A window of its own is not a third value here: that is a live fact about which window is drawing
// the panel, not a preference (composables/floating.ts). One value the user chooses, so the two in-app homes
// are exclusive: docked to the rail, the side column never appears and the rail carries a Chat tile; docked to
// the side, the reverse.
export type ChatHome = "side" | "rail";
// What the ONE workspace sidebar shows: the file explorer, the agent-changes review, or the snapshot timeline
// (VSCode's Source-Control-in-the-sidebar pattern, no second nav column stealing width from the diff view).
export type SidebarPanel = "files" | "changes" | "history";
// How a diff renders its two sides. One setting for every diff surface, see DIFF_LAYOUT_KEY.
export type DiffLayout = "split" | "unified";
// Where a diff LANDS the reader, see DIFF_OPEN_KEY. `top` is Monaco's own answer (the first change in the file,
// import list and all); the other two are reading strategies, and codeLanding.ts turns each into a hunk.
export type DiffOpen = "top" | "imports" | "biggest";

const STORAGE_KEY = `ui-chat-position`;
const WIDTH_KEY = `ui-chat-width`;
const CHAT_HOME_KEY = `ui-chat-home`;

// EVERY WIDTH IN THIS FILE IS IN APP PIXELS, pixels at the app's base text size, which is what all of the
// measurements below were taken at. They are not screen pixels: the base size is a setting, so a column asked
// to hold a header or a path has to grow with the type inside it or the thing it was measured against stops
// fitting. uiScale.ts owns the conversion and names the two edges where it happens (the pointer, and the
// pop-out window); nothing in between converts, and nothing here needs to know the current size.
//
/* HOW NARROW A CHAT PANE MAY BE SQUEEZED, and therefore how narrow the column holding one may be dragged.
 *
 * A terminal at 40 columns is still a terminal; a chat at 300px with tool cards in it is not, so the panel's
 * panes share the room equally down to this and then the row scrolls sideways rather than shrinking on forever
 * (ChatPanel's `.chat-panes`, which imports this rather than writing 22rem of its own).
 *
 * It is exported because the COLUMN'S FLOOR HAS TO BE THE SAME NUMBER. It was not: the column stopped at 288
 * while a pane refused to go under 352, so the last 64px of the drag bought nothing but a horizontal scrollbar
 * across the bottom of the panel, the pane kept its width and the column simply scrolled past it, clipping the
 * composer's right-hand controls and the send button off the edge. A floor under the floor is not a narrower
 * layout, it is the same layout behind a scrollbar, and every width in that gap is a width the panel cannot
 * draw. So there is one minimum and both ends read it. */
export const MIN_PANE_PX = 352;

/* Chat panel width bounds. The max is effectively unlimited, capped only just shy of the viewport so a sliver
 * of workspace always remains.
 *
 * THE DEFAULT IS NOT THE FLOOR, and it used to be: the column shipped at 352, which is also the narrowest a
 * chat may ever be squeezed to. A default sitting on its own minimum has no slack for anything the composer
 * optionally wears, a persona, a run-through badge, the microphone, so the controls under the message box ran
 * out of room on the FIRST screen a new sandbox lands on, which is the one screen where nobody has dragged
 * anything yet.
 *
 * What that overflow COST is fixed in ChatPane, where the control row wraps instead of running out past the
 * column's edge; this buys the room back, so the default spends it on one line rather than two. 432 is measured
 * rather than chosen: the row with every optional pill on it, persona, run-through, the agent's voice, the
 * microphone, stops wrapping at 424 of these, once the labels stop appearing before they fit (ChatPane again),
 * and the rest is slack. In app pixels like everything here, so at the default text size it draws ~475 of the
 * screen's; measuring it in the browser and storing THAT is how a column ends up scaled twice.
 *
 * The floor is the pane's own: someone who deliberately drags the column narrow is asking for the two-line
 * composer, and should get it rather than a scrollbar. */
const DEFAULT_CHAT_WIDTH = 432;
const NARROW_DEFAULT_CHAT_WIDTH = 360;
const MIN_CHAT_WIDTH = MIN_PANE_PX;
const MAX_CHAT_WIDTH = 4000;

const NARROW_DESKTOP_MAX_PX = 1280;
const isNarrowDesktop = (width: number): boolean => width < NARROW_DESKTOP_MAX_PX && width >= 768;

const defaultChatWidth = (): number => (isNarrowDesktop(window.innerWidth) ? NARROW_DEFAULT_CHAT_WIDTH : DEFAULT_CHAT_WIDTH);

// Workspace explorer sidebar, the file-tree column inside the /workspace view. Persisted like the chat width.
//
// The floor is set by what the column must SHOW, not by how thin a file tree can be squeezed: this sidebar wears
// the Files|Changes switch, the restore-points button, and in Changes mode the chip plus the panel's two actions
//: 269px of content at its widest (a "99+" count). The old 180px floor predates the switch moving onto
// the sidebar, and every width under it pushed those actions out past the sidebar's own edge; the old 256px
// default sat a few pixels short too, which is why the Changes chip kept dropping onto a second line. So the
// minimum is the header's own width, and the default clears it with room to spare.
const SIDEBAR_WIDTH_KEY = `ui-workspace-sidebar-width`;
const SIDEBAR_COLLAPSED_KEY = `ui-workspace-sidebar-collapsed`;
const DEFAULT_SIDEBAR_WIDTH = 288;
const NARROW_DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 272;
const MAX_SIDEBAR_WIDTH = 600;

/* The editor's companion pane, the right-hand column of a split (see EditorStrip). Its width rather than a
 * ratio, because what has to stay readable is the pane itself: a percentage silently squeezes a diff below the
 * width its two sides need every time the window or the chat column changes.
 *
 * The floor is a DIFF's floor, not a column's: two gutters, two sets of line numbers and something like eighty
 * characters of code, which is what MIN_PANE_PX already buys the chat, so the same number serves. The default is
 * bigger than the floor for the reason the chat's is (a default sitting on its own minimum has no slack), and
 * the split's own opener clamps it to half the pane it opens in, so a narrow workspace column never hands the
 * companion more room than the document it was opened from. */
const SIDE_PANE_WIDTH_KEY = `ui-workspace-side-pane-width`;
// Exported because the seam's double-click needs the number it resets TO, and a second spelling of it in the
// view is how the two would drift.
export const DEFAULT_SIDE_PANE_WIDTH = 560;
const MIN_SIDE_PANE_WIDTH = MIN_PANE_PX;
const MAX_SIDE_PANE_WIDTH = 4000;

// The agent review panel's file list, the left column in /agents/:id. Its own width, not the workspace
// explorer's: the two columns are never on screen together, and a review list wants room for long paths that
// the file tree (already indented into folders) does not.
const REVIEW_LIST_WIDTH_KEY = `ui-agent-review-list-width`;
const DEFAULT_REVIEW_LIST_WIDTH = 288;
const NARROW_DEFAULT_REVIEW_LIST_WIDTH = 240;
const MIN_REVIEW_LIST_WIDTH = 180;
const MAX_REVIEW_LIST_WIDTH = 800;

const defaultSidebarWidth = (): number => (isNarrowDesktop(window.innerWidth) ? NARROW_DEFAULT_SIDEBAR_WIDTH : DEFAULT_SIDEBAR_WIDTH);
const defaultReviewListWidth = (): number => (isNarrowDesktop(window.innerWidth) ? NARROW_DEFAULT_REVIEW_LIST_WIDTH : DEFAULT_REVIEW_LIST_WIDTH);

// The global terminal, the panel the shell mounts below every view. Only the OPEN state lives here (the rail's
// terminal button + Ctrl+` toggle it); its height belongs to the shared TerminalPanel, persisted per surface.
// Tied to the active sandbox, so opening or closing the terminal in one sandbox does not alter another sandbox's layout.
const terminalOpenKey = (sandboxId: string | undefined): string => `intentic.terminalOpen.${sandboxId ?? `local`}`;
const parseTerminalOpen = (raw: string): boolean | undefined => (raw === `1` ? true : raw === `0` ? false : undefined);

// Which panel the workspace sidebar shows (files | changes | history). Persists like the terminal's open state.
const SIDEBAR_PANEL_KEY = `ui-workspace-sidebar-panel`;

// The file tree's own take on what the search box's includeIgnored (useSearchOptions) does, and it reads the same
// way round: off by default, so the explorer is the project alone, no node_modules/dist/.turbo between the
// reader and it, and on when they want to peek at what the agent also sees (the ignored entries listed, grayed).
// Separate from the search scope because the two answer different questions: what the tree lists, versus what a
// content search walks. Persists.
const SHOW_IGNORED_KEY = `ui-workspace-show-ignored`;

// The explorer's other reading filter, and the reason both now sit behind one funnel in the toolbar: tests are
// tracked project files (nothing ignores them), but a package whose specs sit next to their sources reads as
// twice the code it is when you're finding your way around it. Off by default, hiding source is a choice, not
// a default. See pages/workspace/explorerFilter.ts for what counts as one. Persists.
const HIDE_TESTS_KEY = `ui-workspace-hide-tests`;

// Workspace edit mode, a single global switch (not per file): when on, every editable file opens directly in the
// CodeMirror editor instead of the read-only viewer. Persists like the panels above.
const EDIT_MODE_KEY = `ui-workspace-edit-mode`;

// Comments in a diff, off by default, so every diff surface (workspace tab, agent review, environment card)
// opens on the code alone and comment-only edits don't read as changes. See codeAnalysisClient.ts. Persists.
const SHOW_COMMENTS_KEY = `ui-diff-show-comments`;

// Comments in a file being READ (the workspace file viewer), on by default, the opposite of the diff above, and
// its own switch rather than a second reader of that one. The two answer different questions: a diff asks what the
// code now does, so the prose is noise; opening a file asks what this file says, and its comments are half the
// answer. Hiding them there is a deliberate "just the code" mode, so it starts off and persists once chosen.
const HIDE_FILE_COMMENTS_KEY = `ui-file-hide-comments`;

// Side-by-side or inline, for every diff surface at once, the reader's habit, not a property of the file they
// happen to be looking at. It lives beside showComments because the two are the same kind of setting: how this
// person reads a diff, chosen once, honoured everywhere (DiffToolbar owns the control). Mobile ignores it,
// two panes don't fit a phone, so the stored value is the desktop preference and survives a trip through one.
const DIFF_LAYOUT_KEY = `ui-diff-layout`;

/* Where a diff OPENS, the third of the reader's diff settings, and the one with three answers rather than two.
 * Monaco lands on the first change, which is the import list far more often than it is the change the file was
 * opened for, so every review starts with the same scroll past the same block. Two ways out of that, and they
 * are not the same request:
 *
 *   `imports`  the first change that touches something other than an import. Reading order is intact: the only
 *              thing above where you land is the import list, so nothing can be missed by starting here. The
 *              DEFAULT, for the same reason the comment strip above ships on: the reader came to see what the
 *              code now does, and this is the cheapest way to start on it.
 *   `biggest`  the block with the most changed lines in the file, imports never counted. Lands on the meat and
 *              gives up reading order for it: hunks above the landing are now BEHIND the reader. A triage
 *              setting, chosen by someone skimming a large review, not the one to hand a careful read.
 *   `top`      Monaco's own, for a reader who wants no cleverness at all.
 *
 * None of the three HIDES anything, they only choose a scroll position, and the overview ruler still marks every
 * hunk in the file. Persists. */
const DIFF_OPEN_KEY = `ui-diff-open`;

// The markdown preview's outline rail, the heading list beside a rendered document (MarkdownOutline.vue). ON by
// default: it costs a document nothing (it draws in the gutter the centred prose already leaves, so the reading
// measure never moves) and a reader who has never seen it cannot ask for it. The reader's habit, like the diff
// settings above, not a property of the file, so it holds as they walk from README to README. Persists.
const MARKDOWN_OUTLINE_KEY = `ui-markdown-outline`;

/* Owns shell-layout state shared across areas: where the chat panel sits relative to the workspace (bound onto a
 * `data-chat-position` attribute whose CSS grid swaps off it, mirroring how useTheme drives `data-mode`), the chat
 * panel width, the workspace explorer sidebar width/collapse, and the workspace terminal panel open/height.
 * App-local because these are application layout concepts, not generic @intentic/ui primitives.
 *
 * TWO KINDS OF STATE LIVE HERE, and the line between them is which window is entitled to differ.
 *
 * Everything below is an ACCOUNT PREFERENCE (composables/preference.ts): one answer per seat, live in every
 * window at that seat. Three of them are on /settings/appearance (the explorer's two filters and where a diff
 * opens) and the rest are set from the surfaces they govern, but all of them were already one localStorage key
 * for the whole origin, so a second window has always been entitled to the same answer and merely had no way to
 * hear it until it reloaded.
 *
 * `terminalOpen` is the exception, and deliberately: it is WINDOW state, per sandbox, held through windowStore.ts
 * so two windows can sit on different work. It is not declared as a preference and must not be. */

// Clamp chat width to a floor and to ~95% of the viewport (leaving a sliver of workspace); otherwise unlimited.
// The viewport is the one bound that arrives in screen pixels, so it converts before it is compared, and the
// rail comes off it first: the chat column sits BESIDE the rail in the shell's grid, so a cap of 95% of the
// whole window spends 5% on the sliver and then overflows by the rail's width on any window under ~1.2kpx,
// which put the column's right edge (the composer's margin) past the window and under .shell's clip.
const { iconRailSize } = useIconRailSize();
const clampWidth = (px: number): number => {
    const viewportMax = toAppPx((window.innerWidth - iconRailScreenPx(iconRailSize.value)) * 0.95);
    const max = Math.min(MAX_CHAT_WIDTH, viewportMax);
    return Math.round(Math.max(MIN_CHAT_WIDTH, Math.min(px, max)));
};

const clampSidebarWidth = (px: number): number => Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(px, MAX_SIDEBAR_WIDTH)));

const clampReviewListWidth = (px: number): number => Math.round(Math.max(MIN_REVIEW_LIST_WIDTH, Math.min(px, MAX_REVIEW_LIST_WIDTH)));

const clampSidePaneWidth = (px: number): number => Math.round(Math.max(MIN_SIDE_PANE_WIDTH, Math.min(px, MAX_SIDE_PANE_WIDTH)));

/* THE THREE SHAPES EVERY PREFERENCE BELOW TAKES, as `read`/`write` pairs handed to definePreference. Storage
 * access, the DOM, and telling the other windows are all the primitive's, so what is left here is only what
 * differs between these settings: what a stored string means. */

// `fallback` is what an unset key reads as, so a setting that ships ON is still one line here; anything stored
// is the reader's own answer, and only the exact `1` this file writes counts as true.
const boolPref = (key: string, fallback = false): Ref<boolean> =>
    definePreference<boolean>({ key, read: (raw) => (raw === null ? fallback : raw === `1`), write: (value) => (value ? `1` : `0`) });

const enumPref = <T extends string>(key: string, valid: readonly T[], fallback: T): Ref<T> =>
    definePreference<T>({ key, read: (raw) => (valid.includes(raw as T) ? (raw as T) : fallback), write: (value) => value });

/* A px width, clamped by the column's own bounds: a stale value from a wider screen (or a bounds change in a
 * later build) must never restore a column the viewport can't hold. The clamp is why the primitive does not write
 * back what it adopts, a narrow window echoing its own reading would ratchet the wide window's column down to fit
 * a screen it isn't on. `fallback` is a thunk because it measures the viewport, which is not known at import. */
const widthPref = (key: string, clamp: (px: number) => number, fallback: () => number): Ref<number> =>
    definePreference<number>({
        key,
        read: (raw) => {
            const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
            return Number.isFinite(parsed) ? clamp(parsed) : fallback();
        },
        write: String,
    });

const terminalOpen = ref<boolean>(false);

// Read (and written) against whichever sandbox is active AT THAT MOMENT, never a captured one: a toggle always
// belongs to the sandbox on screen, so there is no window in which a switch that has landed can have the
// previous sandbox's layout written over it.
const restoreTerminalOpen = (): void => {
    terminalOpen.value = readWindowState(terminalOpenKey(activeSandboxId.value), parseTerminalOpen) ?? false;
};
restoreTerminalOpen();

// A switch arrived (composables/sandbox/sandboxScope), show the terminal exactly as this sandbox was left.
export const resetTerminalOpen = (): void => {
    restoreTerminalOpen();
};

const position = enumPref(STORAGE_KEY, [`left`, `right`] as const, `left`);
const chatHome = enumPref(CHAT_HOME_KEY, [`side`, `rail`] as const, `side`);
const chatWidth = widthPref(WIDTH_KEY, clampWidth, defaultChatWidth);
const sidebarWidth = widthPref(SIDEBAR_WIDTH_KEY, clampSidebarWidth, defaultSidebarWidth);
const reviewListWidth = widthPref(REVIEW_LIST_WIDTH_KEY, clampReviewListWidth, defaultReviewListWidth);
const sidePaneWidth = widthPref(SIDE_PANE_WIDTH_KEY, clampSidePaneWidth, () => DEFAULT_SIDE_PANE_WIDTH);
const sidebarCollapsed = boolPref(SIDEBAR_COLLAPSED_KEY);
const sidebarPanel = enumPref(SIDEBAR_PANEL_KEY, [`files`, `changes`, `history`] as const, `files`);
const showIgnored = boolPref(SHOW_IGNORED_KEY);
const hideTests = boolPref(HIDE_TESTS_KEY);
const editMode = boolPref(EDIT_MODE_KEY);
const showComments = boolPref(SHOW_COMMENTS_KEY);
const hideFileComments = boolPref(HIDE_FILE_COMMENTS_KEY);
const diffLayout = enumPref(DIFF_LAYOUT_KEY, [`split`, `unified`] as const, `split`);
const diffOpen = enumPref(DIFF_OPEN_KEY, [`top`, `imports`, `biggest`] as const, `imports`);
const markdownOutline = boolPref(MARKDOWN_OUTLINE_KEY, true);

const set = (value: ChatPosition): void => {
    position.value = value;
};

const toggle = (): void => {
    set(position.value === `left` ? `right` : `left`);
};

// The side (left/right) is kept even while the home is the rail, so docking back returns the column to the
// edge the user had it on rather than resetting a second preference along the way.
const setChatHome = (value: ChatHome): void => {
    chatHome.value = value;
};

// The clamp is here as well as in the preference's own read, and for a different reason: this is a width the
// reader DRAGGED, so it arrives as a pointer position rather than as a stored string.
const setChatWidth = (px: number): void => {
    chatWidth.value = clampWidth(px);
};

const resetChatWidth = (): void => {
    setChatWidth(defaultChatWidth());
};

const setSidebarWidth = (px: number): void => {
    sidebarWidth.value = clampSidebarWidth(px);
};

const resetSidebarWidth = (): void => {
    setSidebarWidth(defaultSidebarWidth());
};

const setReviewListWidth = (px: number): void => {
    reviewListWidth.value = clampReviewListWidth(px);
};

const resetReviewListWidth = (): void => {
    setReviewListWidth(defaultReviewListWidth());
};

// The seam reports a size, so this takes one; the clamp is what keeps a drag past either end from storing a
// companion pane too narrow to read a diff in.
const setSidePaneWidth = (px: number): void => {
    sidePaneWidth.value = clampSidePaneWidth(px);
};

const resetSidePaneWidth = (): void => {
    setSidePaneWidth(DEFAULT_SIDE_PANE_WIDTH);
};

const setSidebarCollapsed = (collapsed: boolean): void => {
    sidebarCollapsed.value = collapsed;
};

const toggleSidebar = (): void => {
    setSidebarCollapsed(!sidebarCollapsed.value);
};

const setTerminalOpen = (open: boolean): void => {
    terminalOpen.value = open;
    writeWindowState(terminalOpenKey(activeSandboxId.value), open ? `1` : `0`);
};

// The toolbar button + Ctrl+` toggle the terminal panel. Sessions live in the shared cache (useTerminal), so
// closing only unmounts the panel, shells keep running and reattach on reopen.
const toggleTerminalVisibility = (): void => {
    setTerminalOpen(!terminalOpen.value);
};

const setSidebarPanel = (panel: SidebarPanel): void => {
    sidebarPanel.value = panel;
    // A badge/banner deep-link into changes/history must never land on a collapsed sidebar.
    if (panel !== `files`) {
        setSidebarCollapsed(false);
    }
};

const toggleShowIgnored = (): void => {
    showIgnored.value = !showIgnored.value;
};

const toggleHideTests = (): void => {
    hideTests.value = !hideTests.value;
};

const setEditMode = (on: boolean): void => {
    editMode.value = on;
};

const toggleShowComments = (): void => {
    showComments.value = !showComments.value;
};

const toggleHideFileComments = (): void => {
    hideFileComments.value = !hideFileComments.value;
};

const setDiffLayout = (value: DiffLayout): void => {
    diffLayout.value = value;
};

const setDiffOpen = (value: DiffOpen): void => {
    diffOpen.value = value;
};

const toggleMarkdownOutline = (): void => {
    markdownOutline.value = !markdownOutline.value;
};

export function useLayout() {
    return {
        position,
        chatHome,
        chatWidth,
        sidebarWidth,
        reviewListWidth,
        sidePaneWidth,
        sidebarCollapsed,
        terminalOpen,
        sidebarPanel,
        showIgnored,
        hideTests,
        editMode,
        showComments,
        hideFileComments,
        diffLayout,
        diffOpen,
        markdownOutline,
        set,
        toggle,
        setChatHome,
        setChatWidth,
        resetChatWidth,
        setSidebarWidth,
        resetSidebarWidth,
        setReviewListWidth,
        resetReviewListWidth,
        setSidePaneWidth,
        resetSidePaneWidth,
        setSidebarCollapsed,
        toggleSidebar,
        setTerminalOpen,
        toggleTerminalVisibility,
        setSidebarPanel,
        toggleShowIgnored,
        toggleHideTests,
        setEditMode,
        toggleShowComments,
        toggleHideFileComments,
        setDiffLayout,
        setDiffOpen,
        toggleMarkdownOutline,
    };
}
