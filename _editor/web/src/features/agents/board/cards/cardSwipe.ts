import type { SwipeAction } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { unregistered } from "../../fleet/agentStatus";
import { canArchive, type FleetAgent } from "../../fleet/useAgents-fleet";

// WHAT A THUMB SWIPING A CARD ASIDE FILES IT AS, on a phone's board: the card's own filing press, the one its menu offers
// (cardMenu.filingRow) and its ⋯ sheet holds, under the same rules, so the swipe can never do what the press would not.
// Archive puts it away with a receipt and Undo, restore brings an archived one back, close drops a card the daemon never
// registered (a draft, a refused send). Filing writes through the active box's fleet store, so a card from another
// sandbox has no swipe, as it has no Archive press.

export type CardSwipe = `archive` | `restore` | `close`;

export const cardSwipeOf = (agent: FleetAgent): CardSwipe | undefined => {
    const here = agent.sandboxId === undefined;
    if (here && agent.archivedAt !== undefined) {
        return `restore`;
    }
    if (here && canArchive(agent)) {
        return `archive`;
    }
    return unregistered(agent.status) ? `close` : undefined;
};

/** What the pane under the card says while it is swiped. Close takes something back, so it wears danger. */
export const cardSwipeAction = (swipe: CardSwipe): SwipeAction => {
    switch (swipe) {
        case `archive`:
            return { label: t(`agents.agentsView.archive`), icon: `box` };
        case `restore`:
            return { label: t(`ui.action.restore`), icon: `undo` };
        case `close`:
            return { label: t(`ui.action.close`), icon: `times`, tone: `danger` };
    }
};
