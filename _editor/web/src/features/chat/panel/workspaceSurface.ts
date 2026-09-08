import { attachmentPreview } from "../drafts/attachmentPreviews";
import { fileLinkDecorator } from "../../../lib/markdown/renderMarkdown";
import { openWorkTerminal } from "../../terminal/useWorkTerminals";
import { openWorkspaceRef } from "../../workspace/files/openFileRef";
import type { ChatSurface } from "../tools/chatToolSurface";

// The app's own ChatSurface for tool cards with a real workspace behind them: shared between chat panes (live
// conversation, shell, browser) and a subagent's transcript page (files only). `agent` picks whose workspace copy a
// path resolves in (workspaceScope), undefined for the shared tree; a getter, since a pane's conversation can change
// under it.
export interface WorkspaceSurfaceOptions {
    readonly agent: () => string | undefined;
    // tmux session for commands, and the browser session for browser tools; absent on a page with no live conversation.
    readonly terminal?: () => string | undefined;
    readonly browser?: () => string | undefined;
    // How a route is entered; passed in (not useRouter()) so this stays a plain function for either caller.
    readonly navigate?: (route: string) => void;
}

export const workspaceSurface = (options: WorkspaceSurfaceOptions): ChatSurface => ({
    imageUrl: attachmentPreview,
    openFile: (path, line) => openWorkspaceRef(path, line, { agent: options.agent() }),
    // Same file-link decoration as the assistant's own prose, rebuilt per fragment since `agent` can change under it.
    decorate: (fragment) => fileLinkDecorator({ agent: options.agent() })(fragment),
    ...(options.terminal === undefined ? {} : { commandTerminal: options.terminal, watchTerminal: openWorkTerminal }),
    ...(options.browser === undefined || options.navigate === undefined
        ? {}
        : { commandBrowser: options.browser, watchBrowser: (session: string) => options.navigate?.(`/browsers/${session}`) }),
    subagentRoute: (toolId) => `/subagents/${toolId}`,
    // No navigate still yields a working link, just a full page load; the honest fallback rather than a dead anchor.
    ...(options.navigate === undefined ? {} : { navigate: options.navigate }),
});
