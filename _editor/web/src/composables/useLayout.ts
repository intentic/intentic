import { ref } from "vue";
import { activeSandboxId } from "./sandbox/activeSandbox";
import { toAppPx } from "./uiScale";
import { readWindowState, writeWindowState } from "./windowStore";

export type ChatPosition = "left" | "right";
// Which HOME the chat lives in: the side column beside every view, or behind a rail tile as the full-screen
// /chat area. A third home — its own pop-out window — is session state, not a preference, and stays with
// usePopout. One value the user chooses, so the two in-app homes are exclusive: docked to the rail, the side
// column never appears and the rail carries a Chat tile; docked to the side, the reverse.
export type ChatHome = "side" | "rail";
// What the ONE workspace sidebar shows: the file explorer, the agent-changes review, or the snapshot timeline
// (VSCode's Source-Control-in-the-sidebar pattern — no second nav column stealing width from the diff view).
export type SidebarPanel = "files" | "changes" | "history";
// How a diff renders its two sides. One setting for every diff surface — see DIFF_LAYOUT_KEY.
export type DiffLayout = "split" | "unified";

const STORAGE_KEY = `ui-chat-position`;
const WIDTH_KEY = `ui-chat-width`;
const CHAT_HOME_KEY = `ui-chat-home`;

// EVERY WIDTH IN THIS FILE IS IN APP PIXELS — pixels at the app's base text size, which is what all of the
// measurements below were taken at. They are not screen pixels: the base size is a setting, so a column asked
// to hold a header or a path has to grow with the type inside it or the thing it was measured against stops
// fitting. uiScale.ts owns the conversion and names the two edges where it happens (the pointer, and the
// pop-out window); nothing in between converts, and nothing here needs to know the current size.
//
/* HOW NARROW A CHAT PANE MAY BE SQUEEZED, and therefore how narrow the column holding one may be dragged.
 *
 * A terminal at 40 columns is still a terminal; a chat at 300px with tool cards in it is not — so the panel's
 * panes share the room equally down to this and then the row scrolls sideways rather than shrinking on forever
 * (ChatPanel's `.chat-panes`, which imports this rather than writing 22rem of its own).
 *
 * It is exported because the COLUMN'S FLOOR HAS TO BE THE SAME NUMBER. It was not: the column stopped at 288
 * while a pane refused to go under 352, so the last 64px of the drag bought nothing but a horizontal scrollbar
 * across the bottom of the panel — the pane kept its width and the column simply scrolled past it, clipping the
 * composer's right-hand controls and the send button off the edge. A floor under the floor is not a narrower
 * layout, it is the same layout behind a scrollbar, and every width in that gap is a width the panel cannot
 * draw. So there is one minimum and both ends read it. */
export const MIN_PANE_PX = 352;

/* Chat panel width bounds. The max is effectively unlimited — capped only just shy of the viewport so a sliver
 * of workspace always remains.
 *
 * THE DEFAULT IS NOT THE FLOOR, and it used to be: the column shipped at 352, which is also the narrowest a
 * chat may ever be squeezed to. A default sitting on its own minimum has no slack for anything the composer
 * optionally wears — a persona, a run-through badge, the microphone — so the controls under the message box ran
 * out of room on the FIRST screen a new sandbox lands on, which is the one screen where nobody has dragged
 * anything yet.
 *
 * What that overflow COST is fixed in ChatPane, where the control row wraps instead of running out past the
 * column's edge; this buys the room back, so the default spends it on one line rather than two. 432 is measured
 * rather than chosen: the row with every optional pill on it — persona, run-through, the agent's voice, the
 * microphone — stops wrapping at 424 of these, once the labels stop appearing before they fit (ChatPane again),
 * and the rest is slack. In app pixels like everything here, so at the default text size it draws ~475 of the
 * screen's; measuring it in the browser and storing THAT is how a column ends up scaled twice.
 *
 * The floor is the pane's own: someone who deliberately drags the column narrow is asking for the two-line
 * composer, and should get it rather than a scrollbar. */
const DEFAULT_CHAT_WIDTH = 432;
const MIN_CHAT_WIDTH = MIN_PANE_PX;
const MAX_CHAT_WIDTH = 4000;

// Workspace explorer sidebar — the file-tree column inside the /workspace view. Persisted like the chat width.
//
// The floor is set by what the column must SHOW, not by how thin a file tree can be squeezed: this sidebar wears
// the Files|Changes switch, the restore-points button, and in Changes mode the chip plus the panel's two actions
// — 269px of content at its widest (a "99+" count). The old 180px floor predates the switch moving onto
// the sidebar, and every width under it pushed those actions out past the sidebar's own edge; the old 256px
// default sat a few pixels short too, which is why the Changes chip kept dropping onto a second line. So the
// minimum is the header's own width, and the default clears it with room to spare.
const SIDEBAR_WIDTH_KEY = `ui-workspace-sidebar-width`;
const SIDEBAR_COLLAPSED_KEY = `ui-workspace-sidebar-collapsed`;
const DEFAULT_SIDEBAR_WIDTH = 288;
const MIN_SIDEBAR_WIDTH = 272;
const MAX_SIDEBAR_WIDTH = 600;

// The agent review panel's file list — the left column in /agents/:id. Its own width, not the workspace
// explorer's: the two columns are never on screen together, and a review list wants room for long paths that
// the file tree (already indented into folders) does not.
const REVIEW_LIST_WIDTH_KEY = `ui-agent-review-list-width`;
const DEFAULT_REVIEW_LIST_WIDTH = 288;
const MIN_REVIEW_LIST_WIDTH = 180;
const MAX_REVIEW_LIST_WIDTH = 800;

// The global terminal — the panel the shell mounts below every view. Only the OPEN state lives here (the rail's
// terminal button + Ctrl+` toggle it); its height belongs to the shared TerminalPanel, persisted per surface.
// Tied to the active sandbox, so opening or closing the terminal in one sandbox does not alter another sandbox's layout.
const terminalOpenKey = (sandboxId: string | undefined): string => `intentic.terminalOpen.${sandboxId ?? `local`}`;
const parseTerminalOpen = (raw: string): boolean | undefined => (raw === `1` ? true : raw === `0` ? false : undefined);

// Which panel the workspace sidebar shows (files | changes | history). Persists like the terminal's open state.
const SIDEBAR_PANEL_KEY = `ui-workspace-sidebar-panel`;

// The file tree's own take on what the search box's includeIgnored (useSearchOptions) does, and it reads the same
// way round: off by default, so the explorer is the project alone — no node_modules/dist/.turbo between the
// reader and it — and on when they want to peek at what the agent also sees (the ignored entries listed, grayed).
// Separate from the search scope because the two answer different questions: what the tree lists, versus what a
// content search walks. Persists.
const SHOW_IGNORED_KEY = `ui-workspace-show-ignored`;

// The explorer's other reading filter, and the reason both now sit behind one funnel in the toolbar: tests are
// tracked project files (nothing ignores them), but a package whose specs sit next to their sources reads as
// twice the code it is when you're finding your way around it. Off by default — hiding source is a choice, not
// a default. See pages/workspace/explorerFilter.ts for what counts as one. Persists.
const HIDE_TESTS_KEY = `ui-workspace-hide-tests`;

// Workspace edit mode — a single global switch (not per file): when on, every editable file opens directly in the
// CodeMirror editor instead of the read-only viewer. Persists like the panels above.
const EDIT_MODE_KEY = `ui-workspace-edit-mode`;

// Comments in a diff — off by default, so every diff surface (workspace tab, agent review, environment card)
// opens on the code alone and comment-only edits don't read as changes. See codeAnalysis.ts. Persists.
const SHOW_COMMENTS_KEY = `ui-diff-show-comments`;

// Comments in a file being READ (the workspace file viewer) — on by default, the opposite of the diff above, and
// its own switch rather than a second reader of that one. The two answer different questions: a diff asks what the
// code now does, so the prose is noise; opening a file asks what this file says, and its comments are half the
// answer. Hiding them there is a deliberate "just the code" mode, so it starts off and persists once chosen.
const HIDE_FILE_COMMENTS_KEY = `ui-file-hide-comments`;

// Side-by-side or inline, for every diff surface at once — the reader's habit, not a property of the file they
// happen to be looking at. It lives beside showComments because the two are the same kind of setting: how this
// person reads a diff, chosen once, honoured everywhere (DiffToolbar owns the control). Mobile ignores it —
// two panes don't fit a phone — so the stored value is the desktop preference and survives a trip through one.
const DIFF_LAYOUT_KEY = `ui-diff-layout`;

// Where a diff OPENS, the third of the reader's diff settings. Monaco lands on the first change, which is the
// import list far more often than it is the change the file was opened for — every review then starts with the
// same scroll past the same block. So the diff opens on the first change that touches something other than an
// import (a file whose only changes ARE imports still opens on them — there is nothing else to show).
//
// On by default, like the comment strip above it and for the same reason: the reader came to see what the code
// now does, and both settings hold back the part of the file that isn't that answer. Neither HIDES anything —
// the imports are one scroll up — so the cost of the default being wrong for someone is a scroll, against a
// scroll on every file of every review for leaving it off. Persists.
const SKIP_IMPORTS_KEY = `ui-diff-skip-imports`;

// The markdown preview's outline rail — the heading list beside a rendered document (MarkdownOutline.vue). ON by
// default: it costs a document nothing (it draws in the gutter the centred prose already leaves, so the reading
// measure never moves) and a reader who has never seen it cannot ask for it. The reader's habit, like the diff
// settings above, not a property of the file — so it holds as they walk from README to README. Persists.
const MARKDOWN_OUTLINE_KEY = `ui-markdown-outline`;

/* Owns shell-layout state shared across areas (module-level singleton): where the chat panel sits relative to
 * the workspace (bound onto a `data-chat-position` attribute whose CSS grid swaps
 * off it — mirroring how useTheme drives `data-mode`), the chat panel width, the workspace explorer
 * sidebar width/collapse, and the workspace terminal panel open/height. App-local because these are
 * application layout concepts, not generic @intentic/ui primitives. */

// Clamp chat width to a floor and to ~95% of the viewport (leaving a sliver of workspace); otherwise unlimited.
// The viewport is the one bound that arrives in screen pixels, so it converts before it is compared.
const clampWidth = (px: number): number => {
    const viewportMax = toAppPx(window.innerWidth * 0.95);
    const max = Math.min(MAX_CHAT_WIDTH, viewportMax);
    return Math.round(Math.max(MIN_CHAT_WIDTH, Math.min(px, max)));
};

const clampSidebarWidth = (px: number): number => Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(px, MAX_SIDEBAR_WIDTH)));

const clampReviewListWidth = (px: number): number => Math.round(Math.max(MIN_REVIEW_LIST_WIDTH, Math.min(px, MAX_REVIEW_LIST_WIDTH)));

// Shared localStorage readers — Storage may be unavailable (private mode); helpers catch and fall back.
// `fallback` is what an unset key reads as, so a setting that ships ON is still one line here; anything stored
// is the reader's own answer, and only the exact `1` this file writes counts as true.
const readBool = (key: string, fallback = false): boolean => {
    try {
        const stored = localStorage.getItem(key);
        return stored === null ? fallback : stored === `1`;
    } catch {
        return fallback;
    }
};

const readEnum = <T extends string>(key: string, valid: readonly T[], fallback: T): T => {
    try {
        const stored = localStorage.getItem(key);
        return valid.includes(stored as T) ? (stored as T) : fallback;
    } catch {
        return fallback;
    }
};

// A stored px width, clamped by the column's own bounds — a stale value from a wider screen (or a bounds change
// in a later build) must never restore a column the viewport can't hold.
const readWidth = (key: string, clamp: (px: number) => number, fallback: number): number => {
    try {
        const stored = localStorage.getItem(key);
        const parsed = stored === null ? Number.NaN : Number.parseInt(stored, 10);
        if (Number.isFinite(parsed)) {
            return clamp(parsed);
        }
    } catch {
        // ignore
    }
    return fallback;
};

const write = (key: string, value: string): void => {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
};

let scopedSandboxId: string | undefined;

const terminalOpen = ref<boolean>(false);

const restoreTerminalOpen = (): void => {
    scopedSandboxId = activeSandboxId.value;
    terminalOpen.value = readWindowState(terminalOpenKey(scopedSandboxId), parseTerminalOpen) ?? false;
};
restoreTerminalOpen();

export const resetTerminalOpen = (): void => {
    restoreTerminalOpen();
};

const position = ref<ChatPosition>(readEnum(STORAGE_KEY, [`left`, `right`] as const, `left`));
const chatHome = ref<ChatHome>(readEnum(CHAT_HOME_KEY, [`side`, `rail`] as const, `side`));
const chatWidth = ref<number>(readWidth(WIDTH_KEY, clampWidth, DEFAULT_CHAT_WIDTH));
const sidebarWidth = ref<number>(readWidth(SIDEBAR_WIDTH_KEY, clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH));
const reviewListWidth = ref<number>(readWidth(REVIEW_LIST_WIDTH_KEY, clampReviewListWidth, DEFAULT_REVIEW_LIST_WIDTH));
const sidebarCollapsed = ref<boolean>(readBool(SIDEBAR_COLLAPSED_KEY));
const sidebarPanel = ref<SidebarPanel>(readEnum(SIDEBAR_PANEL_KEY, [`files`, `changes`, `history`] as const, `files`));
const showIgnored = ref<boolean>(readBool(SHOW_IGNORED_KEY));
const hideTests = ref<boolean>(readBool(HIDE_TESTS_KEY));
const editMode = ref<boolean>(readBool(EDIT_MODE_KEY));
const showComments = ref<boolean>(readBool(SHOW_COMMENTS_KEY));
const hideFileComments = ref<boolean>(readBool(HIDE_FILE_COMMENTS_KEY));
const diffLayout = ref<DiffLayout>(readEnum(DIFF_LAYOUT_KEY, [`split`, `unified`] as const, `split`));
const skipImports = ref<boolean>(readBool(SKIP_IMPORTS_KEY, true));
const markdownOutline = ref<boolean>(readBool(MARKDOWN_OUTLINE_KEY, true));

const set = (value: ChatPosition): void => {
    position.value = value;
    write(STORAGE_KEY, value);
};

const toggle = (): void => {
    set(position.value === `left` ? `right` : `left`);
};

// The side (left/right) is kept even while the home is the rail, so docking back returns the column to the
// edge the user had it on rather than resetting a second preference along the way.
const setChatHome = (value: ChatHome): void => {
    chatHome.value = value;
    write(CHAT_HOME_KEY, value);
};

const setChatWidth = (px: number): void => {
    const width = clampWidth(px);
    chatWidth.value = width;
    write(WIDTH_KEY, String(width));
};

const resetChatWidth = (): void => {
    setChatWidth(DEFAULT_CHAT_WIDTH);
};

const setSidebarWidth = (px: number): void => {
    const width = clampSidebarWidth(px);
    sidebarWidth.value = width;
    write(SIDEBAR_WIDTH_KEY, String(width));
};

const resetSidebarWidth = (): void => {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
};

const setReviewListWidth = (px: number): void => {
    const width = clampReviewListWidth(px);
    reviewListWidth.value = width;
    write(REVIEW_LIST_WIDTH_KEY, String(width));
};

const resetReviewListWidth = (): void => {
    setReviewListWidth(DEFAULT_REVIEW_LIST_WIDTH);
};

const setSidebarCollapsed = (collapsed: boolean): void => {
    sidebarCollapsed.value = collapsed;
    write(SIDEBAR_COLLAPSED_KEY, collapsed ? `1` : `0`);
};

const toggleSidebar = (): void => {
    setSidebarCollapsed(!sidebarCollapsed.value);
};

const setTerminalOpen = (open: boolean): void => {
    terminalOpen.value = open;
    writeWindowState(terminalOpenKey(scopedSandboxId), open ? `1` : `0`);
};

// The toolbar button + Ctrl+` toggle the terminal panel. Sessions live in the shared cache (useTerminal), so
// closing only unmounts the panel — shells keep running and reattach on reopen.
const toggleTerminalVisibility = (): void => {
    setTerminalOpen(!terminalOpen.value);
};

const setSidebarPanel = (panel: SidebarPanel): void => {
    sidebarPanel.value = panel;
    write(SIDEBAR_PANEL_KEY, panel);
    // A badge/banner deep-link into changes/history must never land on a collapsed sidebar.
    if (panel !== `files`) {
        setSidebarCollapsed(false);
    }
};

const toggleShowIgnored = (): void => {
    showIgnored.value = !showIgnored.value;
    write(SHOW_IGNORED_KEY, showIgnored.value ? `1` : `0`);
};

const toggleHideTests = (): void => {
    hideTests.value = !hideTests.value;
    write(HIDE_TESTS_KEY, hideTests.value ? `1` : `0`);
};

const setEditMode = (on: boolean): void => {
    editMode.value = on;
    write(EDIT_MODE_KEY, on ? `1` : `0`);
};

const toggleShowComments = (): void => {
    showComments.value = !showComments.value;
    write(SHOW_COMMENTS_KEY, showComments.value ? `1` : `0`);
};

const toggleHideFileComments = (): void => {
    hideFileComments.value = !hideFileComments.value;
    write(HIDE_FILE_COMMENTS_KEY, hideFileComments.value ? `1` : `0`);
};

const setDiffLayout = (value: DiffLayout): void => {
    diffLayout.value = value;
    write(DIFF_LAYOUT_KEY, value);
};

const toggleSkipImports = (): void => {
    skipImports.value = !skipImports.value;
    write(SKIP_IMPORTS_KEY, skipImports.value ? `1` : `0`);
};

const toggleMarkdownOutline = (): void => {
    markdownOutline.value = !markdownOutline.value;
    write(MARKDOWN_OUTLINE_KEY, markdownOutline.value ? `1` : `0`);
};

export function useLayout() {
    return {
        position,
        chatHome,
        chatWidth,
        sidebarWidth,
        reviewListWidth,
        sidebarCollapsed,
        terminalOpen,
        sidebarPanel,
        showIgnored,
        hideTests,
        editMode,
        showComments,
        hideFileComments,
        diffLayout,
        skipImports,
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
        toggleSkipImports,
        toggleMarkdownOutline,
    };
}
