import { clipboardOf } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, type Ref, ref } from "vue";
import { reviewAction, unregistered, watching } from "../../fleet/agentStatus";
import { boxNameOf, isRemote, openInSandbox } from "../../fleet/fleetScope";
import { canArchive, type FleetAgent } from "../../fleet/useAgents-fleet";
import { bareBranch } from "../session/sessionChip";

// One menu for every card (forty cards cost one node, and only one is ever open), since a card's surface is otherwise
// all press and drag. It adds no actions, only a place to find the ones the card already offers, including glyphs that
// only appear on hover, and the occasional ones a small button would be mis-hit for.

// What the menu is told about a card beyond the card itself.
export interface MenuFacts {
    readonly mobile: boolean;
    // The card is this sandbox's, so writes through the active daemon's roster reach it.
    readonly here: boolean;
    // Its chat is open only as a look.
    readonly peeked: boolean;
    // The agent's page, read only when the menu offers it.
    readonly href: () => string;
    // Another sandbox's name, for the row that crosses to it.
    readonly boxName: string | undefined;
}

// What each row does.
export interface MenuActions {
    readonly focusAgent: (agent: FleetAgent) => void;
    readonly keepAgent: (agent: FleetAgent) => void;
    readonly reviewAgent: (agent: FleetAgent) => void;
    readonly closeAgent: (agent: FleetAgent) => void;
    readonly copySessionName: (branch: string) => Promise<void>;
    readonly openInSandbox: (sandboxId: string, agentId: string) => void;
    readonly stopWatching: (id: string) => Promise<void>;
    readonly restore: (ids: readonly string[]) => Promise<void>;
    readonly archive: (ids?: readonly string[]) => Promise<void>;
}

// The verb+count form ("Stop watching (3)") the card has no room for beside its own truncating note; one row however
// many are armed, since the daemon disarms them together (agents.stopWatching).
const watchRow = (agent: FleetAgent, here: boolean, act: MenuActions): MenuItem[] => {
    const armed = agent.watches?.length ?? 0;
    if (!watching(agent) || !here) {
        return [];
    }
    return [{ label: armed === 1 ? `Stop watching` : `Stop watching (${armed})`, icon: `eye`, command: () => void act.stopWatching(agent.id) }];
};

// Filing away and restoring write through the active box's fleet store, so only its cards get them; closing a
// never-registered card is just this browser's tab.
const filingRow = (agent: FleetAgent, here: boolean, act: MenuActions): MenuItem[] => {
    const filing = !here
        ? []
        : agent.archivedAt !== undefined
          ? [{ label: t(`shared.restore`), icon: `history`, command: () => act.restore([agent.id]) }]
          : canArchive(agent)
            ? [{ label: t(`agents.agentsView.archive`), icon: `box`, command: () => act.archive([agent.id]) }]
            : [];
    return [...filing, ...(unregistered(agent.status) ? [{ label: t(`ui.action.close`), icon: `times`, command: () => act.closeAgent(agent) }] : [])];
};

// Groups rather than a flat list with inline separators: almost every row is conditional, and a separator written inline
// would draw a line under a group that turned out empty.
export const menuItemsFor = (agent: FleetAgent, facts: MenuFacts, act: MenuActions): MenuItem[] => {
    const review = facts.mobile ? undefined : reviewAction(agent);
    const { branch, sandboxId } = agent;
    const groups: MenuItem[][] = [
        [
            { label: t(`ui.action.open`), icon: `arrow-right`, command: () => act.focusAgent(agent) },
            // The press that stops a look going; the chat rail's menu carries the identical row for the identical state.
            ...(facts.peeked ? [{ label: t(`shared.keepOpen`), icon: `pin`, command: () => act.keepAgent(agent) }] : []),
            // A link too, hoverable and Ctrl/Cmd-clickable into its own tab; a plain click still points the chat dock.
            ...(review === undefined ? [] : [{ label: review, icon: `copy`, url: facts.href(), command: () => act.reviewAgent(agent) }]),
        ],
        // The bare name (`sleek-arrow-uzgj`) `agents show`, Quick Open and the worktree path take; `agent/` is git's spelling.
        branch === undefined
            ? []
            : [{ label: t(`agents.agentsView.copySessionName`), icon: `code`, command: () => void act.copySessionName(branch) }],
        // The one press here costing the whole shell, so it names where it goes; it reaches what a remote card's menu drops.
        facts.here || sandboxId === undefined
            ? []
            : [{ label: `Open in ${facts.boxName ?? `its sandbox`}`, icon: `arrow-right`, command: () => act.openInSandbox(sandboxId, agent.id) }],
        watchRow(agent, facts.here, act),
        filingRow(agent, facts.here, act),
    ];
    const items: MenuItem[] = [];
    for (const group of groups.filter((candidate) => candidate.length > 0)) {
        if (items.length > 0) {
            items.push({ separator: true });
        }
        items.push(...group);
    }
    return items;
};

export interface MenuHost {
    readonly mobile: Readonly<Ref<boolean>>;
    readonly peeked: (id: string) => boolean;
    // What a press on a card does (useCardFocus), and where its page is.
    readonly focus: Pick<MenuActions, `focusAgent` | `keepAgent` | `reviewAgent` | `closeAgent`> & {
        readonly agentHref: (agent: FleetAgent) => string;
    };
    // The fleet store's writes.
    readonly agents: Pick<MenuActions, `stopWatching` | `restore` | `archive`>;
}

// The one menu's state: which card it was opened on, and the element that was pressed.
export const useCardMenu = (host: MenuHost) => {
    // The ContextMenu, through the template's `ref`.
    const cardMenu = ref<{ show: (event: Event) => void } | undefined>();
    const menuAgent = ref<FleetAgent>();
    // The element pressed, whose own document the clipboard is asked of (clipboardOf), not this module's `navigator`.
    const menuAnchor = ref<Element>();
    const copySessionName = async (branch: string): Promise<void> => {
        try {
            await clipboardOf(menuAnchor.value).writeText(bareBranch(branch));
        } catch {
            // Clipboard may be unavailable (insecure context); the name is still on the card either way.
        }
    };
    const act: MenuActions = { ...host.focus, ...host.agents, copySessionName, openInSandbox };
    const cardMenuItems = computed<MenuItem[]>(() => {
        const agent = menuAgent.value;
        if (agent === undefined) {
            return [];
        }
        const here = !isRemote(agent);
        const facts: MenuFacts = {
            mobile: host.mobile.value,
            here,
            peeked: host.peeked(agent.id),
            href: () => host.focus.agentHref(agent),
            boxName: here || agent.sandboxId === undefined ? undefined : boxNameOf.value.get(agent.sandboxId),
        };
        return menuItemsFor(agent, facts, act);
    });
    const openCardMenu = (agent: FleetAgent, event: MouseEvent): void => {
        menuAgent.value = agent;
        menuAnchor.value = event.currentTarget instanceof Element ? event.currentTarget : undefined;
        cardMenu.value?.show(event);
    };
    return { cardMenu, cardMenuItems, openCardMenu };
};
