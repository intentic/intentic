import { clipboardOf } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { FreshKind } from "@intentic/sandbox-contract/schemas/agent";
import type { MenuItem } from "primevue/menuitem";
import { useVocabulary } from "../../../workbench/views/vocabulary";
import { startOperation } from "../../../workbench/operations/operations";
import { agentWork } from "../agentActions";
import { unregistered, watching } from "../../agent-status/agentStatus-standing";
import { FRESH_ICONS } from "../freshKinds";
import { canScheduleFresh, canStartFresh, freshKindLabel, freshKindsOf } from "../freshSession";
import { type LandChoice, offersReland } from "./landPress";
import { familyGoing } from "./familyStop";
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
    // The reader is a maintainer, whom the daemon lets land (useTier.canShip).
    readonly canShip: boolean;
    // Where the reader may put the auto-approve mark on (a daemon that serves it, a reader it lets): the cards selected
    // together with this one, which its row marks with it. Absent: no row.
    readonly autoApprove?: { readonly selected: readonly FleetAgent[] } | undefined;
}

// What each shared row does; every surface hands its own, since filing on the board asks first for a family.
export interface AgentMenuActions {
    readonly land: (agent: FleetAgent, chosen: LandChoice) => void;
    // A new chat on the agent's work without its conversation, its ask in the composer (freshSession.ts).
    readonly startFresh: (agent: FleetAgent, kind: FreshKind) => void;
    readonly copySessionName: (branch: string) => Promise<void>;
    readonly stopWatching: (id: string) => Promise<void>;
    // Its turn, its workflow runs and every agent below it, stopped together (familyStop.ts).
    readonly stopAll: (agent: FleetAgent) => void;
    readonly restore: (ids: readonly string[]) => Promise<void>;
    readonly archive: (ids: readonly string[]) => Promise<void>;
    // Puts the auto-approve mark on, or takes it off, these conversations at once.
    readonly setAutoApprove: (ids: readonly string[], on: boolean) => void;
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
// On work whose turn is still live, a check is booked for that turn's end and says so (freshSession.ts canScheduleFresh).
export const freshRows = (agent: FleetAgent, facts: AgentMenuFacts, act: AgentMenuActions): MenuItem[] =>
    !facts.here || (!canStartFresh(agent) && !canScheduleFresh(agent))
        ? []
        : [
              {
                  label: t(`agents.freshSession.menuFresh`),
                  icon: `link`,
                  items: freshKindsOf(agent).map((kind) => ({
                      label: freshKindLabel(agent, kind),
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

// Stop everything (familyStop.ts), beside Stop watching: the other press that ends what would go on without the reader. Only
// while something below the card is at work or will start, since with nothing going the chat's own Stop is all there is.
export const stopAllRows = (agent: FleetAgent, facts: AgentMenuFacts, act: AgentMenuActions): MenuItem[] =>
    !facts.here || agent.archivedAt !== undefined || !familyGoing(agent)
        ? []
        : [{ label: t(`agents.cardMenu.stopAll`), hint: t(`agents.cardMenu.stopAllHint`), icon: `stop`, command: () => act.stopAll(agent) }];

// The auto-approve mark (sandbox-contract schemas/auto-approve.ts): one row that turns it on, or off where the card wears
// its own, for this card and every card selected with it (the panes a Ctrl or Shift click opened), so several sessions
// are marked in one press. The press follows the card it was opened on: off when that one is marked, on otherwise.
export const autoApproveRows = (agent: FleetAgent, facts: AgentMenuFacts, act: AgentMenuActions): MenuItem[] => {
    const reach = facts.autoApprove;
    if (reach === undefined || !facts.here || agent.archivedAt !== undefined || unregistered(agent.status)) {
        return [];
    }
    const together = reach.selected.length > 1 && reach.selected.some((card) => card.id === agent.id) ? reach.selected : [agent];
    const on = agent.autoApprove !== `own`;
    const ids = together.map((card) => card.id);
    return [{ label: autoApproveLabel(on, ids.length), hint: autoApproveHint(agent, on), icon: on ? `bolt` : `shield`, command: () => act.setAutoApprove(ids, on) }];
};

// The mark's route, asked of the daemon and of the reader's access alike before the row is offered.
export const AUTO_APPROVE_ROUTE = `agents.autoApprove` as const;

/** The auto-approve press from a menu, which closes on it: the card's mark moving is the answer, a refusal a receipt. */
export const pressAutoApprove = (write: (ids: readonly string[], on: boolean) => Promise<void>, ids: readonly string[], on: boolean): void => {
    void startOperation(`${agentWork(ids[0] ?? ``)}/auto-approve`, {
        what: t(`agents.autoApprove.label`),
        quiet: true,
        failed: t(`agents.autoApprove.failed`),
        task: () => write(ids, on),
    });
};

// The row's words: which way it goes, and how many cards it takes along.
const autoApproveLabel = (on: boolean, count: number): string => {
    if (count > 1) {
        return on ? t(`agents.autoApprove.markSelected`, { count }) : t(`agents.autoApprove.unmarkSelected`, { count });
    }
    return on ? t(`agents.autoApprove.mark`) : t(`agents.autoApprove.unmark`);
};

// What the press changes, and for a card that already follows its parent's mark, that it does.
const autoApproveHint = (agent: FleetAgent, on: boolean): string => {
    if (!on) {
        return t(`agents.autoApprove.unmarkHint`);
    }
    return agent.autoApprove === `inherited` ? t(`agents.autoApprove.inheritedHint`) : t(`agents.autoApprove.markHint`);
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
