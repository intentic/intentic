import { STATE_DIR, type WorkspaceResolve } from "@intentic/sandbox-contract";
import { router } from "../../../../router";
import { sectionReachable } from "../../../../workbench/views/registry";
import { FILE_SIDE_VIEW, type FileArrival, fileSideInput, missingFileSideInput, noteArrival } from "../../../../workbench/side/sideFileInput";
import { openBeside, sideDocked } from "../../../../workbench/side/sideTabs";
import { handOffToMainWindow } from "../../../../workbench/window/mainWindow";
import { lookUpWorkspaceRef } from "./resolveFileRef";
import { useWorkspaceTabs } from "../../tabs/useWorkspaceTabs";
import { setProjectScope, withinScope } from "../../../../app/projectScope";
import { workspaceAgent, workspaceScope } from "../../../../app/workspaceScope";

// `.intentic` is bind-mounted into every isolated namespace, so a path under it is shared regardless of scope.
export const sharedStatePath = (path: string): boolean => path.startsWith(`${STATE_DIR}/`);

// The one navigation every clickable file reference (terminal link, prose mention, tool card chip) funnels
// through. Split from fileRefs, which only defines what a reference looks like, so the markdown renderer avoids
// pulling in the router or tab singleton.

// Whether this window has a side panel to look at a file in, for a reader the Workspace is open to.
const canLookBeside = (): boolean => sideDocked.value && sectionReachable(`/workspace`);
// Whether a reference is looked at beside rather than opened: anywhere but the Workspace itself.
const peeksBeside = (): boolean => canLookBeside() && router.currentRoute.value.name !== `workspace`;

// What is worth saying beside the file a reference opened: that nothing matched (and what it may have meant), that it is
// one of several, or that the conversation renamed it since. undefined when there is nothing to say, or no answer.
const arrivalFrom = (asked: string, found: WorkspaceResolve | undefined): FileArrival | undefined => {
    if (found === undefined) {
        return undefined;
    }
    const arrival: FileArrival = { asked };
    if (found.path === undefined) {
        if (found.nearby !== undefined) {
            arrival.nearby = found.nearby;
        }
        return arrival;
    }
    if (found.others !== undefined) {
        arrival.matches = [found.path, ...found.others];
    }
    if (found.renamedFrom !== undefined) {
        arrival.renamedFrom = found.renamedFrom;
    }
    return arrival.matches === undefined && arrival.renamedFrom === undefined ? undefined : arrival;
};

// Opens what a reference turned out to mean beside the section: the file, noting how it was reached when that is worth
// saying, or, when nothing matched, a tab that says so and offers what it may have meant. `found` undefined is a daemon
// nobody could ask: the reference opens as written and the file says what it finds.
const openFoundBeside = (asked: string, found: WorkspaceResolve | undefined, agent: string | undefined, line?: number): void => {
    const input = found !== undefined && found.path === undefined ? missingFileSideInput(asked, agent) : fileSideInput(found?.path ?? asked, agent);
    noteArrival(input, arrivalFrom(asked, found));
    openBeside(FILE_SIDE_VIEW, input, line === undefined ? {} : { line });
};

// Resolves the reference before opening it, since a path written in prose is often a suffix of the real one.
// Where it opens is the file's home or beside it: standing in the Workspace, the file opens there; anywhere else it is
// peeked in the side panel and the section the rail put in the main area stays put. A popped-out chat has a side panel of
// its own, so a file mentioned there is looked at there. A window with no side panel (a phone, a popped-out terminal),
// and a reader the Workspace is closed to, keep the Workspace route.
export const openWorkspaceRef = async (path: string, line?: number, asked?: { readonly agent: string | undefined }): Promise<void> => {
    // Set before the hand-off below, so both windows resolve the same file.
    const scope = sharedStatePath(path) ? { agent: undefined } : asked;
    if (peeksBeside()) {
        // Resolved in the copy it names, which the Workspace's own scope is left alone by: a look is not a move.
        const { agent } = scope ?? workspaceScope();
        openFoundBeside(path, await lookUpWorkspaceRef(path, { agent }), agent, line);
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
// peek's "Open in Workspace" still does. Switches the Workspace to the copy the reference named. A reference nothing
// matched opens no editor tab, which would only close again as the read came back empty: with a side panel in the
// window it is said there, as anywhere else, and the Workspace is left as it was.
export const openInWorkspace = async (path: string, line?: number, scope?: { readonly agent: string | undefined }): Promise<void> => {
    // A floating panel has no Workspace to route to; hand off unresolved so the app's own window resolves it.
    if (handOffToMainWindow({ kind: `file`, path, line, scope, home: true })) {
        return;
    }
    const copy = scope ?? workspaceScope();
    const found = await lookUpWorkspaceRef(path, copy);
    if (found !== undefined && found.path === undefined && canLookBeside()) {
        openFoundBeside(path, found, copy.agent, line);
        return;
    }
    // `{ agent: undefined }` means the shared tree, not "leave as is".
    if (scope !== undefined) {
        workspaceAgent.value = scope.agent;
    }
    const target = found?.path ?? path;
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
