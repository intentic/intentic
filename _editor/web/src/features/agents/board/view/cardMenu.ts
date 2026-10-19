import { clipboardOf } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, type Ref, ref } from "vue";
import { drillTarget, reviewAction, reviewBesideDrill } from "../../../../models/agent-status/agentStatus-attention";
import { unregistered, watching } from "../../../../models/agent-status/agentStatus-standing";
import { boxNameOf, isRemote, openInSandbox } from "../../../../models/fleet/fleetScope";
import { canArchive, type FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import { canStartFresh, draftFreshSession } from "../../../../models/fleet/freshSession";
import { FRESH_KINDS, type FreshKind } from "@intentic/sandbox-contract/schemas/agent";
import { FRESH_ICONS } from "../../../../models/fleet/freshKinds";
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
    // What only the card itself can do (its title's field, its reactions' picker), handed over by the card the menu was
    // opened on; a child's row and a card that offers neither hand nothing, and the menu leaves the rows out.
    readonly presses?: CardPresses;
}

// The presses a card makes on itself, which the board cannot reach any other way. Since the card's header keeps only its
// filing press and the ⋯ that opens this menu (AgentCard), these rows are where renaming and reacting live on a desktop.
export interface CardPresses {
    readonly rename?: () => void;
    readonly react?: () => void;
}

// The same, as the card hands them over: its reactions' picker opens from whatever element the menu was opened on.
export interface CardOwnPresses {
    readonly rename?: () => void;
    readonly react?: (from: HTMLElement | undefined) => void;
}

// What each row does.
export interface MenuActions {
    readonly focusAgent: (agent: FleetAgent) => void;
    readonly keepAgent: (agent: FleetAgent) => void;
    readonly reviewAgent: (agent: FleetAgent) => void;
    // The card's own drill-in (useCardFocus.drillIn): the chat for an ask, the review page otherwise.
    readonly drillIn: (agent: FleetAgent) => void;
    readonly closeAgent: (agent: FleetAgent) => void;
    readonly copySessionName: (branch: string) => Promise<void>;
    readonly openInSandbox: (sandboxId: string, agentId: string) => void;
    readonly stopWatching: (id: string) => Promise<void>;
    readonly restore: (ids: readonly string[]) => Promise<void>;
    readonly archive: (ids?: readonly string[]) => Promise<void>;
    // A new chat on the card's work without its conversation, its ask in the composer (freshSession.ts).
    readonly startFresh: (agent: FleetAgent, kind: FreshKind) => void;
}

// The verb+count form ("Stop watching (3)") the card has no room for beside its own truncating note; one row however
// many are armed, since the daemon disarms them together (agents.stopWatching).
const watchRow = (agent: FleetAgent, here: boolean, act: MenuActions): MenuItem[] => {
    const armed = agent.watches?.length ?? 0;
    if (!watching(agent) || !here) {
        return [];
    }
    return [
        {
            label: armed === 1 ? t(`agents.words.stopWatching`) : t(`agents.cardMenu.stopWatchingCount`, { count: armed }),
            icon: `eye`,
            command: () => void act.stopWatching(agent.id),
        },
    ];
};

// Filing away and restoring write through the active box's fleet store, so only its cards get them; closing a
// never-registered card is just this browser's tab.
const filingRow = (agent: FleetAgent, here: boolean, act: MenuActions): MenuItem[] => {
    const filing = !here
        ? []
        : agent.archivedAt !== undefined
          ? [{ label: t(`ui.action.restore`), icon: `history`, command: () => act.restore([agent.id]) }]
          : canArchive(agent)
            ? [{ label: t(`agents.agentsView.archive`), icon: `box`, command: () => act.archive([agent.id]) }]
            : [];
    return [...filing, ...(unregistered(agent.status) ? [{ label: t(`ui.action.close`), icon: `times`, command: () => act.closeAgent(agent) }] : [])];
};

// A second look at the card's work by a session that never read how it was made: one row, opening onto each kind there
// is (a code review, a test pass, the reader's own ask, any added later), none of them first or required. Its work must
// be here to cut a copy from.
const freshRows = (agent: FleetAgent, here: boolean, act: MenuActions): MenuItem[] =>
    !here || !canStartFresh(agent)
        ? []
        : [
              {
                  label: t(`agents.freshSession.menuFresh`),
                  icon: `link`,
                  items: FRESH_KINDS.map((kind) => ({
                      label: t(`agents.freshSession.kind.${kind}`),
                      icon: FRESH_ICONS[kind],
                      command: () => act.startFresh(agent, kind),
                  })),
              },
          ];

// The card's own presses, beside the name they act on.
const ownRows = ({ rename, react }: CardPresses = {}): MenuItem[] => [
    ...(rename === undefined ? [] : [{ label: t(`ui.action.rename`), icon: `pencil`, command: () => rename() }]),
    ...(react === undefined ? [] : [{ label: t(`agents.agentReactions.addReaction`), icon: `plus`, command: () => react() }]),
];

// The card's drill-in. A link too, hoverable and Ctrl/Cmd-clickable into its own tab; a plain click still points the
// chat dock. An ask answered in the chat is no link: the page it would name draws nothing to answer (drillTarget). Such a
// card with written work (a spent allowance stopping it halfway) keeps its diff one row away (reviewBesideDrill).
const drillRows = (agent: FleetAgent, review: string | undefined, facts: MenuFacts, act: MenuActions): MenuItem[] => {
    if (review === undefined) {
        return [];
    }
    const diffRow = { label: t(`agents.agentStatus.reviewChanges`), icon: `copy`, url: facts.href(), command: () => act.reviewAgent(agent) };
    if (drillTarget(agent) === `chat` && facts.here) {
        return [{ label: review, icon: `comments`, command: () => act.drillIn(agent) }, ...(reviewBesideDrill(agent) ? [diffRow] : [])];
    }
    return [{ ...diffRow, label: review }];
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
            ...(facts.peeked ? [{ label: t(`ui.action.keepOpen`), icon: `pin`, command: () => act.keepAgent(agent) }] : []),
            ...drillRows(agent, review, facts, act),
        ],
        freshRows(agent, facts.here, act),
        ownRows(facts.presses),
        // The bare name (`sleek-arrow-uzgj`) `agents show`, Quick Open and the worktree path take; `agent/` is git's spelling.
        branch === undefined
            ? []
            : [{ label: t(`agents.agentsView.copySessionName`), icon: `code`, command: () => void act.copySessionName(branch) }],
        // The one press here costing the whole shell, so it names where it goes; it reaches what a remote card's menu drops.
        facts.here || sandboxId === undefined
            ? []
            : [
                  {
                      label:
                          facts.boxName === undefined ? t(`agents.cardMenu.openInItsSandbox`) : t(`agents.cardMenu.openIn`, { name: facts.boxName }),
                      icon: `arrow-right`,
                      command: () => act.openInSandbox(sandboxId, agent.id),
                  },
              ],
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

// PrimeVue opens a menu where its event says. A press from the keyboard (Enter on the card's ⋯, the menu key on the card)
// says 0,0, the screen's corner, so the menu hangs from the bottom-left of the element pressed instead.
const menuEventAt = (event: MouseEvent): MouseEvent => {
    const target = event.currentTarget;
    if (event.clientX !== 0 || event.clientY !== 0 || !(target instanceof Element)) {
        return event;
    }
    const box = target.getBoundingClientRect();
    return new MouseEvent(event.type, { clientX: box.left, clientY: box.bottom });
};

export interface MenuHost {
    readonly mobile: Readonly<Ref<boolean>>;
    readonly peeked: (id: string) => boolean;
    // What a press on a card does (useCardFocus), and where its page is.
    readonly focus: Pick<MenuActions, `focusAgent` | `keepAgent` | `reviewAgent` | `drillIn` | `closeAgent`> & {
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
    // What the card pressed handed over of its own (CardPresses), bound to the element pressed, which a picker opens from.
    const menuPresses = ref<CardOwnPresses>();
    // The element pressed, whose own document the clipboard is asked of (clipboardOf), not this module's `navigator`.
    const menuAnchor = ref<Element>();
    const copySessionName = async (branch: string): Promise<void> => {
        try {
            await clipboardOf(menuAnchor.value).writeText(bareBranch(branch));
        } catch {
            // Clipboard may be unavailable (insecure context); the name is still on the card either way.
        }
    };
    const act: MenuActions = {
        ...host.focus,
        ...host.agents,
        copySessionName,
        openInSandbox,
        startFresh: (agent, kind) => void draftFreshSession(agent, kind),
    };
    const ownPresses = (): CardPresses | undefined => {
        const presses = menuPresses.value;
        const react = presses?.react;
        const from = menuAnchor.value instanceof HTMLElement ? menuAnchor.value : undefined;
        return presses === undefined ? undefined : { rename: presses.rename, react: react === undefined ? undefined : () => react(from) };
    };
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
            presses: ownPresses(),
        };
        return menuItemsFor(agent, facts, act);
    });
    // A card hands its own presses along (AgentCard's `menu`); a child's row opens the same menu with none.
    const openCardMenu = (agent: FleetAgent, event: MouseEvent, presses?: CardOwnPresses): void => {
        menuAgent.value = agent;
        menuPresses.value = presses;
        menuAnchor.value = event.currentTarget instanceof Element ? event.currentTarget : undefined;
        cardMenu.value?.show(menuEventAt(event));
    };
    return { cardMenu, cardMenuItems, openCardMenu };
};
