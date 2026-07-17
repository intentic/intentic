import { ref } from "vue";
import type { ToolCallLocation, ToolKind } from "@intentic/sandbox-contract";
import { useWorkspaceTabs } from "./useWorkspaceTabs";

/* Follow-along mode (module singleton): while enabled, every edit-category tool_call auto-opens the file the
 * agent is touching, so the workspace tracks the agent live. Content freshness needs no work here — the
 * daemon's workspaceChanged push already re-reads open files (useWorkspaceLive); this only adds the open/
 * scroll. It never navigates between views: on another view the tab updates silently and is simply there
 * when the user returns to the workspace.
 *
 * Known limitation: for isolated (worktree) conversations the main-tree file won't show the agent's edit
 * until land — the tool card's inline diff is the authoritative view there; follow-along is best-effort. */

const KEY = `intentic.followAlong`;

const readEnabled = (): boolean => {
    try {
        return localStorage.getItem(KEY) === `1`;
    } catch {
        // Storage may be unavailable (private mode / tests); default off.
        return false;
    }
};

const enabled = ref(readEnabled());

// One auto-open per path per throttle window, so a burst of edits to one file doesn't thrash the viewer.
const THROTTLE_MS = 2000;
const lastOpened = new Map<string, number>();

const setEnabled = (value: boolean): void => {
    enabled.value = value;
    try {
        localStorage.setItem(KEY, value ? `1` : `0`);
    } catch {
        // In-memory ref still holds.
    }
};

const followToolCall = (event: { readonly category: ToolKind; readonly locations?: readonly ToolCallLocation[] }): void => {
    if (!enabled.value || event.category !== `edit`) {
        return;
    }
    const location = event.locations?.[0];
    if (location === undefined) {
        return;
    }
    const now = Date.now();
    if (now - (lastOpened.get(location.path) ?? 0) < THROTTLE_MS) {
        return;
    }
    lastOpened.set(location.path, now);
    const { openFile, openAtLine } = useWorkspaceTabs();
    if (location.line !== undefined) {
        openAtLine(location.path, location.line);
    } else {
        openFile(location.path);
    }
};

export function useFollowAlong(): {
    enabled: typeof enabled;
    setEnabled: typeof setEnabled;
    followToolCall: typeof followToolCall;
} {
    return { enabled, setEnabled, followToolCall };
}
