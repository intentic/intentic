import { router } from "../../router";
import { useWorkspaceTabs } from "./useWorkspaceTabs";

/* Going to a file reference — the one navigation every clickable path in the app funnels through: a terminal
 * link, a file mention in the assistant's prose, a tool card's location chip.
 *
 * Split from fileRefs (which only knows what a reference LOOKS like) because this half reaches the router and
 * the tab singleton, and the markdown renderer must be able to mark links up without pulling either in. */

// Open a workspace-relative path in the editor and bring the Workspace into view. A path that doesn't resolve
// on disk lands on the file viewer's not-found state rather than failing here.
export const openWorkspaceRef = (path: string, line?: number): void => {
    const { openFile, openAtLine } = useWorkspaceTabs();
    if (line !== undefined) {
        openAtLine(path, line);
    } else {
        openFile(path);
    }
    // Surface the editor (no-op when already on the workspace route — its watchers' equality guards hold).
    void router.push({ name: `workspace`, params: { path: path.split(`/`) } });
};

/* Click handler for the file links inside rendered markdown. Delegated, like the code blocks' copy buttons:
 * the anchors live inside v-html, so they can hold no component and no per-link listener; one handler on the
 * prose root covers every link in it.
 *
 * Each link is a real `<a href="/workspace/…">`, so a modified click (new tab, new window) is left to the
 * browser and opens the file exactly as a shared link would — only a plain left click is intercepted, which
 * keeps the SPA from reloading and lets the jump carry a line number the URL has no room for. */
export const openFileRefFromEvent = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
    }
    const link = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>(`a.md-file-link`);
    const path = link?.dataset[`file`];
    if (link === null || link === undefined || path === undefined || path === ``) {
        return;
    }
    event.preventDefault();
    const line = Number(link.dataset[`line`]);
    openWorkspaceRef(path, Number.isInteger(line) && line > 0 ? line : undefined);
};
