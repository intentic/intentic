import { STATE_DIR } from "@intentic/sandbox-contract";
import { router } from "../../router";
import { handOffToMainWindow } from "../mainWindow";
import { resolveWorkspaceRef } from "./resolveFileRef";
import { useWorkspaceTabs } from "./useWorkspaceTabs";
import { workspaceAgent } from "./workspaceScope";

/* THE DAEMON'S OWN STATE IS ONE TREE, whoever names it. `.intentic` is bind-mounted from the main checkout into
 * an isolated turn's namespace (sandbox agents/isolation.ts), precisely so a transcript written there reaches
 * the daemon rather than dying with the worktree, which makes every path under it shared by construction.
 *
 * So a reference into it answers "whose copy?" by itself, and the answer overrides the asking card's. It has to:
 * the CLI's plan files live here (`.intentic/records/sessions/claude/plans/…`), an isolated conversation writes
 * one and then asks about it, and opened in that conversation's checkout the file is simply not there. */
const sharedStatePath = (path: string): boolean => path.startsWith(`${STATE_DIR}/`);

/* Going to a file reference, the one navigation every clickable path in the app funnels through: a terminal
 * link, a file mention in the assistant's prose, a tool card's location chip.
 *
 * Split from fileRefs (which only knows what a reference LOOKS like) because this half reaches the router and
 * the tab singleton, and the markdown renderer must be able to mark links up without pulling either in. */

/* Open the file a reference names in the editor and bring the Workspace into view.
 *
 * The reference is resolved first (resolveWorkspaceRef) rather than opened literally, because a path written
 * in prose is routinely a suffix of the real one, `pages/workspace/Foo.vue` for a file that lives under
 * `_editor/web/src`. A reference nothing matches is opened as written, which lands on the file viewer's
 * not-found state naming exactly what was clicked. */
export const openWorkspaceRef = async (path: string, line?: number, asked?: { readonly agent: string | undefined }): Promise<void> => {
    // Settled before anything else, including the hand-off below, so both windows resolve the same file.
    const scope = sharedStatePath(path) ? { agent: undefined } : asked;
    /* NOT IN A POPPED-OUT PANEL. A floating window holds one panel and no app: routing it to the editor would
     * take away the chat the reader is reading to make room for a view that window was never meant to hold. So
     * the reference is handed to the app's own window, which opens the file and raises itself, and this window
     * does not move at all. With no such window left, that call opens one (composables/mainWindow.ts).
     *
     * Handed over WHOLE and unresolved, before the scope below is touched: resolution asks the daemon within
     * one workspace's tree, so it belongs to the window that will do the opening. */
    if (handOffToMainWindow({ kind: `file`, path, line, scope })) {
        return;
    }
    /* WHOSE COPY, and the difference between "the shared tree" and "whichever one we are already in".
     *
     * A caller that KNOWS, a link in a conversation's prose, a tool card, passes the scope, and passing
     * `{ agent: undefined }` is a real answer meaning the shared tree: a link in a shared conversation must
     * take the reader out of an agent's copy, not silently open that agent's version of the file.
     *
     * A caller that does NOT know omits it, and the current scope stands. Terminal output is the case: the
     * pane has no conversation to ask, and clearing the scope from under a reader who is browsing an agent's
     * copy would answer a question nobody asked.
     *
     * Set BEFORE the reference is resolved, because resolution asks the daemon which file the reference means
     *, and a file an isolated conversation has not landed exists in no other tree, so asked against the
     * shared one it comes back unresolved and the link lands on a not-found page for a file that is right
     * there.
     */
    if (scope !== undefined) {
        workspaceAgent.value = scope.agent;
    }
    const target = (await resolveWorkspaceRef(path)) ?? path;
    const { openFile, openAtLine } = useWorkspaceTabs();
    if (line !== undefined) {
        openAtLine(target, line);
    } else {
        openFile(target);
    }
    // Surface the editor (no-op when already on the workspace route, its watchers' equality guards hold). The
    // scope rides the query so the route and the singleton agree even on the first navigation into the view.
    const agent = workspaceAgent.value;
    void router.push({ name: `workspace`, params: { path: target.split(`/`) }, query: agent === undefined ? {} : { agent } });
};

/* Click handler for the file links inside rendered markdown. Delegated, like the code blocks' copy buttons:
 * the anchors live inside v-html, so they can hold no component and no per-link listener; one handler on the
 * prose root covers every link in it.
 *
 * Each link is a real `<a href="/workspace/…">`, so a modified click (new tab, new window) is left to the
 * browser and opens the file exactly as a shared link would, only a plain left click is intercepted, which
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
    // Every markdown link knows its scope, including "the shared tree", a shared conversation's link carries
    // no `data-agent`, and that absence is the answer, not a missing one.
    void openWorkspaceRef(path, Number.isInteger(line) && line > 0 ? line : undefined, { agent: link.dataset[`agent`] });
};
