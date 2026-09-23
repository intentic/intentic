import { computed, provide } from "vue";
import type { Router } from "vue-router";
import { navigateInApp } from "../../../../shell/window/mainWindow";
import type { Conversation } from "../../session/conversation";
import { CHAT_SURFACE } from "../../tools/chatToolSurface";
import type { useShotViewer } from "../../transcript/shots/useShotViewer";
import { workspaceSurface } from "../workspaceSurface";

// What this pane's tool cards can lead to: the chat's own checkout, terminal and browser, and the pictures its turns
// showed the agent; per pane, so two chats side by side each offer their own. A popped-out chat has no app in it, so
// navigation goes to the app's own window.

export interface PaneSurfaceHost {
    readonly conversation: () => Conversation;
    readonly router: Router;
    // This pane's picture viewer, which holds every picture a turn's strip shows.
    readonly viewer: Pick<ReturnType<typeof useShotViewer>, "viewCall">;
}

export const usePaneSurface = (pane: PaneSurfaceHost) => {
    // Whose checkout this chat's files and pictures are read in; undefined for a chat working in the shared tree.
    const scope = (): string | undefined => (pane.conversation().isolated.value ? pane.conversation().conversationId : undefined);
    const workspace = workspaceSurface({
        agent: scope,
        terminal: () => pane.conversation().agentTerminal.value,
        browser: () => pane.conversation().agentBrowser.value,
        conversation: () => ({ id: pane.conversation().conversationId, at: pane.conversation().box.value }),
        navigate: (route) => navigateInApp(pane.router, route),
    });
    provide(CHAT_SURFACE, {
        ...workspace,
        // In this pane's viewer, or as the file when no turn's strip holds it (an attachment read back).
        viewPicture: (toolId, path) => {
            if (!pane.viewer.viewCall(toolId, path)) {
                workspace.openFile?.(path);
            }
        },
    });
    return { pictureScope: computed(scope) };
};
