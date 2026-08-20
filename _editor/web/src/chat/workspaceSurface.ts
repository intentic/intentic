import { attachmentPreview } from "../composables/chat/attachmentPreviews";
import { openWorkTerminal } from "../composables/terminal/useWorkTerminals";
import { openWorkspaceRef } from "../composables/workspace/openFileRef";
import type { ChatSurface } from "./chatSurface";

/* THE APP'S OWN CHAT SURFACE, everything a tool card can lead to when there IS a workspace behind it.
 *
 * The half of ChatToolCard that used to be imported straight into the component, now stated once here so the
 * component itself holds no opinion about where it is mounted. Two callers with genuinely different answers:
 * a chat PANE, which has a live conversation and therefore a shell and a browser to attach to, and a
 * subagent's transcript page, which has neither and wants only the files and pictures.
 *
 * `agent` is whose copy of the workspace this conversation's paths name (workspaceScope). An isolated
 * conversation works in its own checkout, so a file it named is the one in THAT tree, the shared tree's file
 * of the same path is a different file, or none at all, and linking there is how "I edited auth.ts" led to a
 * not-found page. Undefined for a shared-workspace conversation: /work IS its tree. Read through a getter
 * rather than passed as a value, because a pane's conversation changes under it. */
export interface WorkspaceSurfaceOptions {
    readonly agent: () => string | undefined;
    // The tmux session an agent's commands run in, and the browser session its browser tools drive. A page
    // with no live conversation behind it supplies neither, and its cards simply carry no watch buttons.
    readonly terminal?: () => string | undefined;
    readonly browser?: () => string | undefined;
    // How a route is entered. Passed in rather than taken from useRouter() so this stays a plain function,
    // the two callers are components and already have one.
    readonly navigate?: (route: string) => void;
}

export const workspaceSurface = (options: WorkspaceSurfaceOptions): ChatSurface => ({
    imageUrl: attachmentPreview,
    openFile: (path, line) => openWorkspaceRef(path, line, { agent: options.agent() }),
    ...(options.terminal === undefined ? {} : { commandTerminal: options.terminal, watchTerminal: openWorkTerminal }),
    ...(options.browser === undefined || options.navigate === undefined
        ? {}
        : { commandBrowser: options.browser, watchBrowser: (session: string) => options.navigate?.(`/browsers/${session}`) }),
    subagentRoute: (toolId) => `/subagents/${toolId}`,
    // A page with no navigate of its own still gets a working link, it just costs a full load, which for the
    // subagent page linking to another subagent is the honest fallback rather than a dead anchor.
    ...(options.navigate === undefined ? {} : { navigate: options.navigate }),
});
