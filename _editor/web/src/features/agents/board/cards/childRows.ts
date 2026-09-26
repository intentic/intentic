import type { ComponentPublicInstance, InjectionKey, Ref } from "vue";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import type { TrayState } from "../view/childFold";

// What a card's tray of children reads from the board that draws it. Provided rather than passed as props, because the
// board memoises each card's subtree (AgentsView's v-memo) and a tray has to follow its children, its fold and the ring
// on its own clock: an injected read is tracked by the tray itself, so a child's tick redraws that tray and no card.
export interface ChildRowsBoard {
    // The children riding under a card (childFold), one steady list per card while its members stand still.
    readonly childrenOf: (card: FleetAgent) => readonly FleetAgent[];
    // The fold, the filter and the ring, as they bear on this card's tray.
    readonly stateOf: (card: FleetAgent) => TrayState;
    readonly toggle: (card: FleetAgent) => void;
    // This child's chat is on screen, in the docked panel or one of several panes.
    readonly selected: (id: string) => boolean;
    readonly needle: Readonly<Ref<string>>;
    readonly matchCase: Readonly<Ref<boolean>>;
    // The card's own presses, answered for a row exactly as for a card (useCardFocus, useCardMenu).
    readonly open: (child: FleetAgent, event?: MouseEvent) => void;
    readonly review: (child: FleetAgent) => void;
    readonly menu: (child: FleetAgent, event: MouseEvent) => void;
    // Registers a row with the board's motion (laneMotion), so a link can scroll to it and a child leaving its row for a
    // card of its own flies from where it stood.
    readonly setRowEl: (id: string, el: Element | ComponentPublicInstance | null) => void;
}

export const CHILD_ROWS: InjectionKey<ChildRowsBoard> = Symbol(`agents.childRows`);
