import { t } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import type { Ref } from "vue";
import { useRouter } from "vue-router";
import { useRole } from "../../../client/sandbox/useRole";
import { drillTarget, reviewAction, reviewBesideDrill } from "../../../models/agent-status/agentStatus-attention";
import type { Conversation } from "../../../models/conversations/session/conversation";
import { draftFreshSession } from "../../../models/fleet/freshSession";
import {
    type AgentMenuActions,
    type AgentMenuFacts,
    copySessionName,
    filingRows,
    freshRows,
    landRows,
    sessionNameRows,
    watchRows,
} from "../../../models/fleet/presses/agentMenu";
import { landFromMenu } from "../../../models/fleet/presses/landPress";
import { useAgents } from "../../../models/fleet/useAgents";
import type { FleetAgent } from "../../../models/fleet/useAgents-fleet";
import { commandShortcut } from "../../../workbench/commands/useCommands";
import { navigateInApp } from "../../../workbench/window/mainWindow";

// What a chat row's agent offers in the row's menu: the same rows its board card's menu draws (models/fleet/presses/
// agentMenu.ts), pressed the same way, except a land, which says its refusal as a toast since no board strip is here to
// carry it (landFromMenu). The menu itself, with the chat's own rows around these, is useChatRowActions'.

export interface ChatRowAgentRows {
    // Review changes and Land now, leading the menu.
    readonly review: MenuItem[];
    readonly fresh: MenuItem[];
    // Copy session name, beside the chat's own Rename and Share.
    readonly name: MenuItem[];
    readonly watch: MenuItem[];
    // Archive or Restore, beside the chat's own Close.
    readonly filing: MenuItem[];
}

const NONE: ChatRowAgentRows = { review: [], fresh: [], name: [], watch: [], filing: [] };

/** The agent rows for a chat's menu; `anchor` is the row pressed, whose own document the clipboard is asked of. */
export const useChatRowAgentRows = (anchor: Ref<Element | undefined>) => {
    const { agentById, archive, restore, stopWatching } = useAgents();
    const { canShip } = useRole();
    const router = useRouter();
    const act: AgentMenuActions = {
        land: (agent, chosen) => void landFromMenu(agent, chosen),
        startFresh: (agent, kind) => void draftFreshSession(agent, kind),
        copySessionName: (branch) => copySessionName(branch, anchor.value),
        stopWatching,
        restore,
        archive: (ids) => archive(ids),
    };
    // The agent's review page, under the words the card's own drill-in wears when that is where it goes (reviewAction),
    // and as Review changes beside one that goes to the chat (reviewBesideDrill): this row IS the chat, so a drill-in into
    // it would go nowhere.
    const reviewRows = (agent: FleetAgent): MenuItem[] => {
        const open = (): void => navigateInApp(router, `/agents/${encodeURIComponent(agent.id)}`);
        if (drillTarget(agent) === `review`) {
            const label = reviewAction(agent);
            return label === undefined ? [] : [{ label, icon: `copy`, command: open }];
        }
        return reviewBesideDrill(agent) ? [{ label: t(`agents.agentStatus.reviewChanges`), icon: `copy`, command: open }] : [];
    };
    return (conversation: Conversation): ChatRowAgentRows => {
        // Only this sandbox's roster answers here: another box's chat offers none of its agent's rows.
        const agent = conversation.box.value === undefined ? agentById(conversation.conversationId) : undefined;
        if (agent === undefined) {
            return NONE;
        }
        const facts: AgentMenuFacts = { here: true, canShip: canShip.value };
        return {
            review: [...reviewRows(agent), ...landRows(agent, facts, act)],
            fresh: freshRows(agent, facts, act),
            name: sessionNameRows(agent, act),
            watch: watchRows(agent, facts, act),
            filing: filingRows(agent, facts, act, commandShortcut(`chat.archive`)),
        };
    };
};
