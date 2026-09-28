import type { SubagentSession } from "@intentic/sandbox-contract";
import type { Router } from "vue-router";
import { useAgents } from "../../../agents/fleet/useAgents";
import { agentSeed } from "../../../agents/fleet/useAgents-actions";
import { summonChat } from "../../run/summon";
import { agentTabOf } from "../useChat-reveal";
import { snapshotTab } from "../../tabs/tabSnapshot";
import { fileLinkDecorator } from "../../../../lib/markdown/renderMarkdown";
import { navigateInApp } from "../../../../shell/window/mainWindow";
import { openWorkTerminal } from "../../../terminal/useWorkTerminals";
import { openWorkspaceRef } from "../../../workspace/files/refs/openFileRef";
import { picture } from "../../../workspace/home/thumbnails";
import type { Conversation } from "../../session/conversation";
import type { ChatSurface } from "../../tools/chatToolSurface";
import { agentToolChildren } from "../../transcript/agentTranscript";
import type { useShotViewer } from "../../transcript/shots/useShotViewer";

// What a pane's tool cards can lead to: the chat's own checkout, terminal and browser, the calls a delegation's card
// holds in the chat's record, navigating in the app's own window, and the roster's word on the subagents its calls
// started. A path resolves in the conversation's own copy of the workspace (workspaceScope), the shared tree for none;
// read through getters, since a pane's conversation can change under it.
export const paneSurface = (conversation: () => Conversation, router: Router, subagents: () => readonly SubagentSession[]): ChatSurface => {
    const agent = (): string | undefined => conversation().scope.value;
    const navigate = (route: string): void => navigateInApp(router, route);
    return {
        // The daemon's re-encoded view rather than the file, in the conversation's own scope like `openFile`.
        imageUrl: (path) => picture(agent(), path, `view`)?.url,
        openFile: (path, line) => openWorkspaceRef(path, line, { agent: agent() }),
        // Same file-link decoration as the assistant's own prose, rebuilt per fragment since `agent` can change under it.
        decorate: (fragment) => fileLinkDecorator({ agent: agent() })(fragment),
        commandTerminal: () => conversation().agentTerminal.value,
        watchTerminal: openWorkTerminal,
        commandBrowser: () => conversation().agentBrowser.value,
        watchBrowser: (session) => navigate(`/browsers/${session}`),
        toolChildren: (toolId) => {
            const chat = conversation();
            return agentToolChildren(chat.conversationId, toolId, chat.box.value);
        },
        conversationRoute: (id) => `/agents/${encodeURIComponent(id)}`,
        subagent: (id) => subagents().find((session) => session.id === id),
        navigate,
        // A spawned child opens as a look, as its row in the tray does; an in-process one steps this chat's column into it.
        openSubagent: ({ id, kind }) => {
            const agents = useAgents();
            if (kind === `spawned`) {
                const child = agents.agentById(id);
                if (child === undefined) {
                    navigate(`/agents/${encodeURIComponent(id)}`);
                    return;
                }
                agents.open(child, `peek`);
                return;
            }
            const chat = conversation();
            const card = agents.agentById(chat.conversationId);
            summonChat({ kind: `subagent`, parent: card === undefined ? snapshotTab(chat) : agentTabOf(agentSeed(card)), id });
        },
    };
};

// The same surface under the turns, whose pictures open in the pane's viewer, or as the file where no strip holds one.
export const viewingIn = (surface: ChatSurface, viewer: Pick<ReturnType<typeof useShotViewer>, "viewCall">): ChatSurface => ({
    ...surface,
    viewPicture: (toolId, path) => {
        if (!viewer.viewCall(toolId, path)) {
            surface.openFile?.(path);
        }
    },
});
