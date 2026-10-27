import { clipboardOf } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { FRESH_KINDS, type FreshKind } from "@intentic/sandbox-contract/schemas/agent";
import type { MenuItem } from "primevue/menuitem";
import { useVocabulary } from "../../../workbench/views/vocabulary";
import { watching } from "../../agent-status/agentStatus-standing";
import { FRESH_ICONS } from "../freshKinds";
import { canStartFresh } from "../freshSession";
import { type LandChoice, offersReland } from "./landPress";
import { canArchive, type FleetAgent } from "../useAgents-fleet";

// THE ROWS AN AGENT OFFERS FROM ANY MENU DRAWN FOR IT: the board card's (features/agents/board/view/cardMenu.ts) and
// the chat list row's (features/chat/tabs/useChatRowActions.ts), so the same agent can never offer one thing on the board
// and another in the chat beside it. Each surface keeps only what is its own around these: the board its Open and
// drill-in, the chat its panes, its tab closes and its window. Every builder answers a group, empty where it has nothing
// to offer, and `joinGroups` draws the rules between the ones that are left.

// What a menu is told about where it is drawn.
export interface AgentMenuFacts {
    // The agent is this sandbox's, so writes through the active daemon's roster reach it.
    readonly here: boolean;
    // The reader is a maintainer, whom the daemon lets land (useRole.canShip).
    readonly canShip: boolean;
}

// What each shared row does; every surface hands its own, since filing on the board asks first for a family.
export interface AgentMenuActions {
    readonly land: (agent: FleetAgent, chosen: LandChoice) => void;
    // A new chat on the agent's work without its conversation, its ask in the composer (freshSession.ts).
    readonly startFresh: (agent: FleetAgent, kind: FreshKind) => void;
    readonly copySessionName: (branch: string) => Promise<void>;
    readonly stopWatching: (id: string) => Promise<void>;
    readonly restore: (ids: readonly string[]) => Promise<void>;
    readonly archive: (ids: readonly string[]) => Promise<void>;
}

// The session's own name: for an isolated agent this is its conversation id, which every handle-taker (the CLI, Quick
// Open, the worktree path) resolves; `agent/` is git's word for it, not the session's.
const BRANCH_PREFIX = `agent/`;
export const bareBranch = (branch: string): string => (branch.startsWith(BRANCH_PREFIX) ? branch.slice(BRANCH_PREFIX.length) : branch);

/** Copies the bare session name through the document `from` sits in (clipboardOf), quietly where the clipboard refuses. */
export const copySessionName = async (branch: string, from: Element | undefined): Promise<void> => {
    try {
        await clipboardOf(from).writeText(bareBranch(branch));
    } catch {
        // allow(silent-catch): the clipboard is refused in an insecure context, and the name is still on the card to read.
    }
};

// The card's own Land now, or Land again where landed work left the workspace: a maintainer's press, never on work filed
// away. Land again replaces Land now rather than joining it, since a plain land would leave the discarded part missing.
export const landRows = (agent: FleetAgent, facts: AgentMenuFacts, act: AgentMenuActions): MenuItem[] => {
    if (!facts.canShip || agent.archivedAt !== undefined) {
        return [];
    }
    const words = useVocabulary().value;
    if (offersReland(agent)) {
        return [{ label: words.landAgain, icon: `undo`, disabled: agent.status === `landing`, command: () => act.land(agent, `reland`) }];
    }
    return agent.status === `ready` ? [{ label: words.land, icon: `check`, command: () => act.land(agent, `land`) }] : [];
};

// A second look at the agent's work by a session that never read how it was made: one row, opening onto each kind there
// is (a code review, a test pass, the reader's own ask, any added later), none of them first or required. Its work must
// be here to cut a copy from.
export const freshRows = (agent: FleetAgent, facts: AgentMenuFacts, act: AgentMenuActions): MenuItem[] =>
    !facts.here || !canStartFresh(agent)
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

// The bare name (`sleek-arrow-uzgj`) `agents show`, Quick Open and the worktree path take; `agent/` is git's spelling.
export const sessionNameRows = (agent: FleetAgent, act: AgentMenuActions): MenuItem[] => {
    const { branch } = agent;
    return branch === undefined ? [] : [{ label: t(`agents.agentsView.copySessionName`), icon: `code`, command: () => void act.copySessionName(branch) }];
};

// The verb+count form ("Stop watching (3)") a card has no room for beside its own truncating note; one row however
// many are armed, since the daemon disarms them together (agents.stopWatching).
export const watchRows = (agent: FleetAgent, facts: AgentMenuFacts, act: AgentMenuActions): MenuItem[] => {
    const armed = agent.watches?.length ?? 0;
    if (!watching(agent) || !facts.here) {
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

// Filing away and restoring write through the active box's fleet store, so only its agents get them. `shortcut` is the
// chord a surface binds its own Archive to, taught on the row.
export const filingRows = (agent: FleetAgent, facts: AgentMenuFacts, act: AgentMenuActions, shortcut?: string): MenuItem[] => {
    if (!facts.here) {
        return [];
    }
    if (agent.archivedAt !== undefined) {
        return [{ label: t(`ui.action.restore`), icon: `history`, command: () => void act.restore([agent.id]) }];
    }
    return canArchive(agent) ? [{ label: t(`agents.agentsView.archive`), icon: `box`, shortcut, command: () => void act.archive([agent.id]) }] : [];
};

// Groups rather than a flat list with inline separators: almost every row is conditional, and a separator written inline
// would draw a line under a group that turned out empty.
export const joinGroups = (groups: readonly (readonly MenuItem[])[]): MenuItem[] => {
    const items: MenuItem[] = [];
    for (const group of groups.filter((candidate) => candidate.length > 0)) {
        if (items.length > 0) {
            items.push({ separator: true });
        }
        items.push(...group);
    }
    return items;
};
