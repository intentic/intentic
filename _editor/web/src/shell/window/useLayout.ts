import { ref, type Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";
import { activeSandboxId } from "../../features/sandbox/overview/activeSandbox";
import { iconRailScreenPx, useIconRailSize } from "../rail/useIconRailSize";
import { toAppPx } from "./uiScale";
import { readWindowState, writeWindowState } from "./windowStore";

export type ChatPosition = "left" | "right";
// Where the chat lives: beside every view, or behind a rail tile as /chat. A window of its own is a separate live fact
// (floating.ts), not a third value; the two homes are mutually exclusive.
export type ChatHome = "side" | "rail";
// What the one workspace sidebar shows: file explorer, agent-changes review, or the snapshot timeline.
export type SidebarPanel = "files" | "changes" | "history";
// How a diff renders its two sides, one setting for every diff surface (see DIFF_LAYOUT_KEY).
export type DiffLayout = "split" | "unified";
// Where a diff lands the reader (see DIFF_OPEN_KEY); `top` is Monaco's default, the other two are reading strategies
// turned into a hunk by codeLanding.ts.
export type DiffOpen = "top" | "imports" | "biggest";

const STORAGE_KEY = `ui-chat-position`;
const WIDTH_KEY = `ui-chat-width`;
const CHAT_HOME_KEY = `ui-chat-home`;

// Every width here is in app pixels (uiScale.ts owns the screen-pixel conversion), not screen pixels; nothing in this
// file converts.
// Shared by chat panes and their column floor; a mismatch reintroduces a scrollbar, not a narrower layout.
export const MIN_PANE_PX = 352;

// Default leaves slack above the floor for the composer's optional controls; max stays under the viewport.
const DEFAULT_CHAT_WIDTH = 432;
const NARROW_DEFAULT_CHAT_WIDTH = 360;
const MIN_CHAT_WIDTH = MIN_PANE_PX;
const MAX_CHAT_WIDTH = 4000;

const NARROW_DESKTOP_MAX_PX = 1280;
const isNarrowDesktop = (width: number): boolean => width < NARROW_DESKTOP_MAX_PX && width >= 768;

// Exported so <ResizeSeam> reads the same bounds and reset value the setters enforce, rather than a second copy that
// could drift.
export const defaultChatWidth = (): number => (isNarrowDesktop(window.innerWidth) ? NARROW_DEFAULT_CHAT_WIDTH : DEFAULT_CHAT_WIDTH);
export { MIN_CHAT_WIDTH };

// Floor is set by what the sidebar's header controls need (~269px), not by how narrow a file tree could go.
const SIDEBAR_WIDTH_KEY = `ui-workspace-sidebar-width`;
const SIDEBAR_COLLAPSED_KEY = `ui-workspace-sidebar-collapsed`;
const DEFAULT_SIDEBAR_WIDTH = 288;
const NARROW_DEFAULT_SIDEBAR_WIDTH = 240;
export const MIN_SIDEBAR_WIDTH = 272;
export const MAX_SIDEBAR_WIDTH = 600;

// A fixed width, not a ratio: a percentage could squeeze the diff below a readable width as the window resizes. Its
// floor matches MIN_PANE_PX; the opener also clamps it to half its container.
const SIDE_PANE_WIDTH_KEY = `ui-workspace-side-pane-width`;
// Exported so the seam's double-click reset uses the same number, rather than a second copy that could drift.
export const DEFAULT_SIDE_PANE_WIDTH = 560;
const MIN_SIDE_PANE_WIDTH = MIN_PANE_PX;
const MAX_SIDE_PANE_WIDTH = 4000;

// The agent review panel's own file list width, separate from the workspace explorer's since the two never appear
// together and a review list needs room for full paths.
const REVIEW_LIST_WIDTH_KEY = `ui-agent-review-list-width`;
const DEFAULT_REVIEW_LIST_WIDTH = 288;
const NARROW_DEFAULT_REVIEW_LIST_WIDTH = 240;
export const MIN_REVIEW_LIST_WIDTH = 180;
export const MAX_REVIEW_LIST_WIDTH = 800;

export const defaultSidebarWidth = (): number => (isNarrowDesktop(window.innerWidth) ? NARROW_DEFAULT_SIDEBAR_WIDTH : DEFAULT_SIDEBAR_WIDTH);
export const defaultReviewListWidth = (): number => (isNarrowDesktop(window.innerWidth) ? NARROW_DEFAULT_REVIEW_LIST_WIDTH : DEFAULT_REVIEW_LIST_WIDTH);

// Only the open state lives here; height belongs to the shared TerminalPanel. Tied to the active sandbox, so toggling
// it in one sandbox doesn't affect another's layout.
const terminalOpenKey = (sandboxId: string | undefined): string => `intentic.terminalOpen.${sandboxId ?? `local`}`;
const parseTerminalOpen = (raw: string): boolean | undefined => (raw === `1` ? true : raw === `0` ? false : undefined);

// Which panel the workspace sidebar shows; persists like the terminal's open state.
const SIDEBAR_PANEL_KEY = `ui-workspace-sidebar-panel`;

// Off by default, hiding ignored entries (node_modules, dist, etc.) from the tree; separate from search's own
// includeIgnored, since listing and searching answer different questions.
const SHOW_IGNORED_KEY = `ui-workspace-show-ignored`;

// Off by default; hides files pages/workspace/explorerFilter.ts counts as tests, since a package with specs beside its
// sources reads as more code than it is.
const HIDE_TESTS_KEY = `ui-workspace-hide-tests`;

// Global, not per file: on, every editable file opens directly in CodeMirror instead of the viewer.
const EDIT_MODE_KEY = `ui-workspace-edit-mode`;

// Off by default for every diff surface, so comment-only edits don't read as code changes.
const SHOW_COMMENTS_KEY = `ui-diff-show-comments`;

// On by default for the file viewer, the opposite of the diff setting: reading a file is reading its comments too, so
// hiding them is an opt-in "just the code" mode.
const HIDE_FILE_COMMENTS_KEY = `ui-file-hide-comments`;

// Side-by-side or inline, for every diff surface at once; a reading habit, not a file property (DiffToolbar owns the
// control). Ignored on mobile, where two panes don't fit.
const DIFF_LAYOUT_KEY = `ui-diff-layout`;

// Where a diff opens the reader; Monaco's own landing (first change) is usually the import list rather than the change
// under review.
// - imports: first change past the import list; the default, since nothing above it can be missed.
// - biggest: the block with the most changed lines; a triage setting that gives up reading order.
// - top: Monaco's own landing, no cleverness.
// None of the three hides anything; the overview ruler still marks every hunk in the file.
const DIFF_OPEN_KEY = `ui-diff-open`;

// On by default: costs a document nothing (draws in already-unused gutter space) and a reader who's never seen it can't
// ask for it.
const MARKDOWN_OUTLINE_KEY = `ui-markdown-outline`;

// Shell-layout state: chat position/width, sidebar width/collapse, terminal open state; app-local since these are
// layout concepts, not @intentic/ui primitives. Everything below is an account preference (shared across every window
// at that seat) except `terminalOpen`, which is per-window, per-sandbox state held via windowStore.ts.

// Clamped to a floor and ~95% of the viewport, sliver reserved for the workspace, after subtracting the icon rail's
// width (the chat column sits beside it) and converting from screen pixels.
const { iconRailSize } = useIconRailSize();
/**
 * The one bound that moves: tracks the viewport and the rail beside it, so the seam is handed a function rather than a
 * constant.
 */
export const maxChatWidth = (): number => Math.min(MAX_CHAT_WIDTH, toAppPx((window.innerWidth - iconRailScreenPx(iconRailSize.value)) * 0.95));
const clampWidth = (px: number): number => Math.round(Math.max(MIN_CHAT_WIDTH, Math.min(px, maxChatWidth())));

const clampSidebarWidth = (px: number): number => Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(px, MAX_SIDEBAR_WIDTH)));

const clampReviewListWidth = (px: number): number => Math.round(Math.max(MIN_REVIEW_LIST_WIDTH, Math.min(px, MAX_REVIEW_LIST_WIDTH)));

const clampSidePaneWidth = (px: number): number => Math.round(Math.max(MIN_SIDE_PANE_WIDTH, Math.min(px, MAX_SIDE_PANE_WIDTH)));

// Three preference shapes built on definePreference, which owns storage, DOM and cross-window sync; only what a stored
// string means differs between them.

// `fallback` is what an unset key reads as; any other stored value is read literally, only the exact `1` this writes
// counts as true.
const boolPref = (key: string, fallback = false): Ref<boolean> =>
    definePreference<boolean>({ key, read: (raw) => (raw === null ? fallback : raw === `1`), write: (value) => (value ? `1` : `0`) });

const enumPref = <T extends string>(key: string, valid: readonly T[], fallback: T): Ref<T> =>
    definePreference<T>({ key, read: (raw) => (valid.includes(raw as T) ? (raw as T) : fallback), write: (value) => value });

// Clamps a stored width to the column's bounds; not written back, or a narrow window would ratchet down a wide window's
// stored value. `fallback` is a thunk since it reads the viewport at call time.
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

// Reads against whichever sandbox is active at call time, never a captured one, so a toggle always belongs to the
// sandbox on screen.
const restoreTerminalOpen = (): void => {
    terminalOpen.value = readWindowState(terminalOpenKey(activeSandboxId.value), parseTerminalOpen) ?? false;
};
restoreTerminalOpen();

// Called when a sandbox switch lands, to show the terminal exactly as that sandbox was left.
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

// Side (left/right) is kept while docked to the rail, so undocking returns the column to its prior edge.
const setChatHome = (value: ChatHome): void => {
    chatHome.value = value;
};

// Clamped here too, since this arrives as a raw drag position rather than a stored string.
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

// Clamped here since the seam reports a raw drag position, not a pre-clamped stored value.
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

// Toggles the panel only; terminal sessions live in the shared cache (useTerminal) and reattach on reopen rather than
// restarting.
const toggleTerminalVisibility = (): void => {
    setTerminalOpen(!terminalOpen.value);
};

const setSidebarPanel = (panel: SidebarPanel): void => {
    sidebarPanel.value = panel;
    // A deep link into changes/history must not land on a collapsed sidebar.
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
