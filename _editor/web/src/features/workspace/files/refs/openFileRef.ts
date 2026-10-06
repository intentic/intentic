import { STATE_DIR } from "@intentic/sandbox-contract";
import { router } from "../../../../router";
import { sectionReachable } from "../../../../workbench/views/registry";
import { FILE_SIDE_VIEW, fileSideInput } from "../../../../workbench/side/sideFileInput";
import { openBeside, sideDocked } from "../../../../workbench/side/sideTabs";
import { handOffToMainWindow } from "../../../../workbench/window/mainWindow";
import { resolveWorkspaceRef } from "./resolveFileRef";
import { useWorkspaceTabs } from "../../tabs/useWorkspaceTabs";
import { setProjectScope, withinScope } from "../../../../app/projectScope";
import { workspaceAgent, workspaceScope } from "../../../../app/workspaceScope";

// `.intentic` is bind-mounted into every isolated namespace, so a path under it is shared regardless of scope.
export const sharedStatePath = (path: string): boolean => path.startsWith(`${STATE_DIR}/`);

// The one navigation every clickable file reference (terminal link, prose mention, tool card chip) funnels
// through. Split from fileRefs, which only defines what a reference looks like, so the markdown renderer avoids
// pulling in the router or tab singleton.

// Resolves the reference before opening it, since a path written in prose is often a suffix of the real one;
// an unresolved reference opens as written.
// Where it opens is the file's home or beside it: standing in the Workspace, the file opens there; anywhere else it is
// peeked in the side panel and the section the rail put in the main area stays put. A popped-out chat has a side panel of
// its own, so a file mentioned there is looked at there. A window with no side panel (a phone, a popped-out terminal),
// and a reader the Workspace is closed to, keep the Workspace route.
export const openWorkspaceRef = async (path: string, line?: number, asked?: { readonly agent: string | undefined }): Promise<void> => {
    // Set before the hand-off below, so both windows resolve the same file.
    const scope = sharedStatePath(path) ? { agent: undefined } : asked;
    if (sideDocked.value && router.currentRoute.value.name !== `workspace` && sectionReachable(`/workspace`)) {
        // Resolved in the copy it names, which the Workspace's own scope is left alone by: a look is not a move.
        const { agent } = scope ?? workspaceScope();
        const target = (await resolveWorkspaceRef(path, { agent })) ?? path;
        openBeside(FILE_SIDE_VIEW, fileSideInput(target, agent), line === undefined ? {} : { line });
        return;
    }
    // Any other popped-out panel has no app to route to; hand off unresolved so the app's own window resolves it, and
    // decides there whether it opens beside.
    if (handOffToMainWindow({ kind: `file`, path, line, scope })) {
        return;
    }
    await openInWorkspace(path, line, scope);
};

// The Workspace route itself, with the file open in its editor: what a reference did before the side panel, and what a
// peek's "Open in Workspace" still does. Switches the Workspace to the copy the reference named.
export const openInWorkspace = async (path: string, line?: number, scope?: { readonly agent: string | undefined }): Promise<void> => {
    // A floating panel has no Workspace to route to; hand off unresolved so the app's own window resolves it.
    if (handOffToMainWindow({ kind: `file`, path, line, scope, home: true })) {
        return;
    }
    // `{ agent: undefined }` means the shared tree, not "leave as is"; set before resolving, which reads it.
    if (scope !== undefined) {
        workspaceAgent.value = scope.agent;
    }
    const target = (await resolveWorkspaceRef(path)) ?? path;
    // A reference outside the open project (another project's file, or the state dir, which is outside every project)
    // names a file no scoped tree or home can show. Widening to the whole workspace is the same move the agent scope
    // above makes: what is being opened is what has to be on screen, so the folder it lives in has to be reachable.
    if (!withinScope(target)) {
        setProjectScope(undefined);
    }
    const { openFile, openAtLine } = useWorkspaceTabs();
    if (line !== undefined) {
        openAtLine(target, line);
    } else {
        openFile(target);
    }
    // No-op when already on the route; the scope rides the query so the route and singleton stay in sync.
    const agent = workspaceAgent.value;
    void router.push({ name: `workspace`, params: { path: target.split(`/`) }, query: agent === undefined ? {} : { agent } });
};

// Delegated click handler for file links rendered inside v-html (anchors host no per-link listener). A modified
// click is left to the browser; a plain left click is intercepted to avoid an SPA reload and carry the line number.
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
    // A shared conversation's link carries no `data-agent`; that absence means the shared tree, not "unset".
    void openWorkspaceRef(path, Number.isInteger(line) && line > 0 ? line : undefined, { agent: link.dataset[`agent`] });
};
