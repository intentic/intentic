import type { Router } from "vue-router";
import { navigateInApp } from "../../../../shell/window/mainWindow";
import type { Conversation } from "../../session/conversation";
import type { ChatSurface } from "../../tools/chatToolSurface";
import type { useShotViewer } from "../../transcript/shots/useShotViewer";
import { workspaceSurface } from "../workspaceSurface";

// What a pane's tool cards can lead to: the chat's own checkout, terminal and browser, navigating in the app's own window.
export const paneSurface = (conversation: () => Conversation, router: Router): ChatSurface =>
    workspaceSurface({
        agent: () => conversation().scope.value,
        terminal: () => conversation().agentTerminal.value,
        browser: () => conversation().agentBrowser.value,
        conversation: () => ({ id: conversation().conversationId, at: conversation().box.value }),
        navigate: (route) => navigateInApp(router, route),
    });

// The same surface under the turns, whose pictures open in the pane's viewer, or as the file where no strip holds one.
export const viewingIn = (surface: ChatSurface, viewer: Pick<ReturnType<typeof useShotViewer>, "viewCall">): ChatSurface => ({
    ...surface,
    viewPicture: (toolId, path) => {
        if (!viewer.viewCall(toolId, path)) {
            surface.openFile?.(path);
        }
    },
});
