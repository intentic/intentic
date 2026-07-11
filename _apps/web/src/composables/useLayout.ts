import { ref } from "vue";

export type ChatPosition = "left" | "right";
// What the ONE workspace sidebar shows: the file explorer, the agent-changes review, or the snapshot timeline
// (VSCode's Source-Control-in-the-sidebar pattern — no second nav column stealing width from the diff view).
export type SidebarPanel = "files" | "changes" | "history";

const STORAGE_KEY = `ui-chat-position`;
const WIDTH_KEY = `ui-chat-width`;

// Chat panel width bounds (px). Default matches the original fixed 22rem column. The max is effectively
// unlimited — capped only just shy of the viewport so a sliver of workspace always remains.
const DEFAULT_CHAT_WIDTH = 352;
const MIN_CHAT_WIDTH = 288;
const MAX_CHAT_WIDTH = 4000;

// Workspace explorer sidebar — the file-tree column inside the /workspace view. Persisted like the chat width.
const SIDEBAR_WIDTH_KEY = `ui-workspace-sidebar-width`;
const SIDEBAR_COLLAPSED_KEY = `ui-workspace-sidebar-collapsed`;
const DEFAULT_SIDEBAR_WIDTH = 256;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 600;

// Workspace terminal — the bottom panel inside the /workspace view. Only the OPEN state lives here (the
// toolbar button + Ctrl+` toggle it); height/collapse belong to the shared TerminalPanel, persisted per surface.
const TERMINAL_OPEN_KEY = `ui-workspace-terminal-open`;

// Which panel the workspace sidebar shows (files | changes | history). Persists like the terminal's open state.
const SIDEBAR_PANEL_KEY = `ui-workspace-sidebar-panel`;

// Workspace content-search scope — when on, content search descends into ignored files (node_modules,
// .gitignore'd paths); off by default. The file tree is unaffected: it always lists everything, graying the
// ignored entries. Persists.
const INCLUDE_IGNORED_KEY = `ui-workspace-include-ignored`;

// Workspace edit mode — a single global switch (not per file): when on, every editable file opens directly in the
// CodeMirror editor instead of the read-only viewer. Persists like the panels above.
const EDIT_MODE_KEY = `ui-workspace-edit-mode`;

/* Owns shell-layout state shared across areas (module-level singleton): where the chat panel sits relative to
 * the workspace (bound onto a `data-chat-position` attribute whose CSS grid swaps
 * off it — mirroring how useTheme drives `data-mode`), the chat panel width, the workspace explorer
 * sidebar width/collapse, and the workspace terminal panel open/height/maximized. App-local because these are
 * application layout concepts, not generic @intentic-app/ui primitives. */

// Clamp chat width to a floor and to ~95% of the viewport (leaving a sliver of workspace); otherwise unlimited.
const clampWidth = (px: number): number => {
    const viewportMax = window.innerWidth * 0.95;
    const max = Math.min(MAX_CHAT_WIDTH, viewportMax);
    return Math.round(Math.max(MIN_CHAT_WIDTH, Math.min(px, max)));
};

const clampSidebarWidth = (px: number): number => Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(px, MAX_SIDEBAR_WIDTH)));

// Shared localStorage readers — Storage may be unavailable (private mode); helpers catch and fall back.
const readBool = (key: string): boolean => {
    try {
        return localStorage.getItem(key) === `1`;
    } catch {
        return false;
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

const readWidth = (): number => {
    try {
        const stored = localStorage.getItem(WIDTH_KEY);
        const parsed = stored === null ? Number.NaN : Number.parseInt(stored, 10);
        if (Number.isFinite(parsed)) {
            return clampWidth(parsed);
        }
    } catch {
        // ignore
    }
    return DEFAULT_CHAT_WIDTH;
};

const readSidebarWidth = (): number => {
    try {
        const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
        const parsed = stored === null ? Number.NaN : Number.parseInt(stored, 10);
        if (Number.isFinite(parsed)) {
            return clampSidebarWidth(parsed);
        }
    } catch {
        // ignore
    }
    return DEFAULT_SIDEBAR_WIDTH;
};

const write = (key: string, value: string): void => {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
};

const position = ref<ChatPosition>(readEnum(STORAGE_KEY, [`left`, `right`] as const, `left`));
const chatWidth = ref<number>(readWidth());
const sidebarWidth = ref<number>(readSidebarWidth());
const sidebarCollapsed = ref<boolean>(readBool(SIDEBAR_COLLAPSED_KEY));
const terminalOpen = ref<boolean>(readBool(TERMINAL_OPEN_KEY));
const sidebarPanel = ref<SidebarPanel>(readEnum(SIDEBAR_PANEL_KEY, [`files`, `changes`, `history`] as const, `files`));
const includeIgnored = ref<boolean>(readBool(INCLUDE_IGNORED_KEY));
const editMode = ref<boolean>(readBool(EDIT_MODE_KEY));

const set = (value: ChatPosition): void => {
    position.value = value;
    write(STORAGE_KEY, value);
};

const toggle = (): void => {
    set(position.value === `left` ? `right` : `left`);
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

const setSidebarCollapsed = (collapsed: boolean): void => {
    sidebarCollapsed.value = collapsed;
    write(SIDEBAR_COLLAPSED_KEY, collapsed ? `1` : `0`);
};

const toggleSidebar = (): void => {
    setSidebarCollapsed(!sidebarCollapsed.value);
};

const setTerminalOpen = (open: boolean): void => {
    terminalOpen.value = open;
    write(TERMINAL_OPEN_KEY, open ? `1` : `0`);
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

const toggleIncludeIgnored = (): void => {
    includeIgnored.value = !includeIgnored.value;
    write(INCLUDE_IGNORED_KEY, includeIgnored.value ? `1` : `0`);
};

const setEditMode = (on: boolean): void => {
    editMode.value = on;
    write(EDIT_MODE_KEY, on ? `1` : `0`);
};

export function useLayout() {
    return {
        position,
        chatWidth,
        sidebarWidth,
        sidebarCollapsed,
        terminalOpen,
        sidebarPanel,
        includeIgnored,
        editMode,
        set,
        toggle,
        setChatWidth,
        resetChatWidth,
        setSidebarWidth,
        resetSidebarWidth,
        setSidebarCollapsed,
        toggleSidebar,
        setTerminalOpen,
        toggleTerminalVisibility,
        setSidebarPanel,
        toggleIncludeIgnored,
        setEditMode,
    };
}
