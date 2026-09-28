import type { SubagentSession } from "@intentic/sandbox-contract";
import type { ComponentPublicInstance, InjectionKey, Ref } from "vue";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import type { IdMatch } from "../idMatch";
import type { TrayState } from "../view/childFold";

// What a card's tray of children reads from the board that draws it. Provided rather than passed as props, because the
// board memoises each card's subtree (AgentsView's v-memo) and a tray has to follow its children, its fold and the ring
// on its own clock: an injected read is tracked by the tray itself, so a child's tick redraws that tray and no card.
export interface ChildRowsBoard {
    // The children riding under a card (childFold), one steady list per card while its members stand still.
    readonly childrenOf: (card: FleetAgent) => readonly FleetAgent[];
    // The subagents the card's runtime ran in-process, from the roster: in the same tray, with no chat of their own.
    readonly subagentsOf: (card: FleetAgent) => readonly SubagentSession[];
    // The folds, the filter and the ring, as they bear on this card's tray.
    readonly stateOf: (card: FleetAgent) => TrayState;
    // Opens or shuts one of the card's folds: its settled children by default, or a group of children stopped on one
    // thing, named by what they stopped on (childFold.stopOf).
    readonly toggle: (card: FleetAgent, fold?: string) => void;
    // This child's chat is on screen, in the docked panel or one of several panes.
    readonly selected: (id: string) => boolean;
    readonly needle: Readonly<Ref<string>>;
    readonly matchCase: Readonly<Ref<boolean>>;
    // What the filter's id tier found on a child (idMatch.ts), drawn on its row as a card draws it.
    readonly idMatchOf: (child: FleetAgent) => IdMatch | undefined;
    // The card's own presses, answered for a row exactly as for a card (useCardFocus, useCardMenu). An in-process
    // subagent's row opens its parent's chat, where its work is: on the card of the call that started it.
    readonly open: (child: FleetAgent, event?: MouseEvent) => void;
    readonly review: (child: FleetAgent) => void;
    readonly menu: (child: FleetAgent, event: MouseEvent) => void;
    // Registers a row with the board's motion (laneMotion), so a link can scroll to it and a child leaving its row for a
    // card of its own flies from where it stood.
    readonly setRowEl: (id: string, el: Element | ComponentPublicInstance | null) => void;
}

export const CHILD_ROWS: InjectionKey<ChildRowsBoard> = Symbol(`agents.childRows`);
