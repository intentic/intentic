import { STATE_DIR } from "@intentic/sandbox-contract";
import { router } from "../../../router";
import { handOffToMainWindow } from "../../../shell/window/mainWindow";
import { resolveWorkspaceRef } from "./resolveFileRef";
import { useWorkspaceTabs } from "../tabs/useWorkspaceTabs";
import { workspaceAgent } from "../health/workspaceScope";

// `.intentic` is bind-mounted into every isolated namespace, so a path under it is shared regardless of scope.
const sharedStatePath = (path: string): boolean => path.startsWith(`${STATE_DIR}/`);

// The one navigation every clickable file reference (terminal link, prose mention, tool card chip) funnels
// through. Split from fileRefs, which only defines what a reference looks like, so the markdown renderer avoids
// pulling in the router or tab singleton.

// Resolves the reference before opening it, since a path written in prose is often a suffix of the real one;
// an unresolved reference opens as written.
export const openWorkspaceRef = async (path: string, line?: number, asked?: { readonly agent: string | undefined }): Promise<void> => {
    // Set before the hand-off below, so both windows resolve the same file.
    const scope = sharedStatePath(path) ? { agent: undefined } : asked;
    // A floating panel has no app to route to; hand off unresolved so the app's own window resolves it.
    if (handOffToMainWindow({ kind: `file`, path, line, scope })) {
        return;
    }
    // `{ agent: undefined }` means the shared tree, not "leave as is"; set before resolving, which reads it.
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
