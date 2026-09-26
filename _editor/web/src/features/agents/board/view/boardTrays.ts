import { computed, type Ref, shallowRef } from "vue";
import { canArchive, type FleetAgent, withKeptWords } from "../../fleet/useAgents-fleet";
import { insideRun } from "../../fleet/useWorkflowRuns";
import { cardKey, type ChildFold, foldChildren, steadyFold, type Tray, trayOf, type TrayState } from "./childFold";

// The children riding under the board's cards (childFold), as the lanes read them: whose tray a child is in, what a tray
// draws against the board's filter, ring and folds, and the archive's own fold, whose filed children ride under their
// filed parent exactly as live ones do on the board.

export interface TraysHost {
    // What the scope folded (boardScope): the children under each card, and the card each child is under.
    readonly scope: {
        readonly boardChildren: Readonly<Ref<ReadonlyMap<string, readonly FleetAgent[]>>>;
        readonly boardHosts: Readonly<Ref<ReadonlyMap<string, FleetAgent>>>;
        readonly ledgerRunIds: Readonly<Ref<ReadonlySet<string>>>;
    };
    // The store's archive, as read so far.
    readonly archived: Readonly<Ref<readonly FleetAgent[]>>;
    readonly filter: {
        readonly active: Readonly<Ref<boolean>>;
        readonly matches: (agent: FleetAgent) => boolean;
    };
    // The card wearing the ring.
    readonly selected: Readonly<Ref<string | undefined>>;
}

export const useBoardTrays = (host: TraysHost) => {
    const { scope, filter } = host;
    // A run's steps are filed away with the run, or the archive would show one run row plus its five conversations. A
    // parent's children ride under its card there too, every one of them: nothing in the archive asks for a press.
    const archiveFold = computed<ChildFold>((previous) => {
        const filed = host.archived.value.filter((agent) => !insideRun(agent, scope.ledgerRunIds.value)).map(withKeptWords);
        return steadyFold(previous, foldChildren({ attention: [], active: [], finished: filed }, () => false));
    });
    const archivedCards = computed(() => archiveFold.value.lanes.finished);
    // What rides under a card: the archive's own fold for a filed card, the board's for one on it.
    const childrenOf = (card: FleetAgent): readonly FleetAgent[] =>
        (card.archivedAt === undefined ? scope.boardChildren.value : archiveFold.value.children).get(cardKey(card)) ?? [];
    // The card a child is drawn under, if it rides under one; a card stands for itself.
    const cardOf = (agent: FleetAgent): FleetAgent =>
        (agent.archivedAt === undefined ? scope.boardHosts.value : archiveFold.value.hosts).get(cardKey(agent)) ?? agent;
    // A card stays under a query when it or anything riding under it matched, as a run answers for its steps: a child
    // has no card of its own to answer with, and its parent's is where the reader goes looking for it.
    const answers = (card: FleetAgent): boolean => filter.matches(card) || childrenOf(card).some(filter.matches);
    // The ring on a child keeps the card it rides under in Finished's window, or the ring would be on nothing drawn.
    const selectedCard = computed(() => {
        const id = host.selected.value;
        return id === undefined ? undefined : (scope.boardHosts.value.get(id)?.id ?? id);
    });
    // The trays whose settled children the reader unfolded, by card. The board's own, not remembered: a fold reopened
    // after a visit elsewhere would bury the lane under a list the reader had finished with.
    const openTrays = shallowRef<ReadonlySet<string>>(new Set());
    const toggleTray = (card: FleetAgent): void => {
        const next = new Set(openTrays.value);
        const key = cardKey(card);
        if (!next.delete(key)) {
            next.add(key);
        }
        openTrays.value = next;
    };
    // The fold, the filter and the ring, as they bear on one card's tray.
    const trayState = (card: FleetAgent): TrayState => ({
        open: openTrays.value.has(cardKey(card)),
        filtering: filter.active.value,
        matches: filter.matches,
        selected: host.selected.value,
    });
    // What a card's tray draws (childFold.trayOf).
    const trayFor = (card: FleetAgent): Tray | undefined => trayOf(childrenOf(card), trayState(card));
    // What files away or comes back with a card: the settled children riding under it, as a run's archive takes its
    // steps. Filing the parent alone would spill every helper it ever started back onto the board as cards of their
    // own; restoring it brings back the ones filed under it. A child still working is never taken, and stands as its
    // own card once its parent has left.
    const familyOf = (card: FleetAgent): readonly FleetAgent[] =>
        card.archivedAt === undefined ? childrenOf(card).filter(canArchive) : childrenOf(card);
    const familyIds = (card: FleetAgent): string[] => [card.id, ...familyOf(card).map((child) => child.id)];
    // The ids a press names, each widened to its family, for a press that names cards by id (the card menu's).
    const withFamilies = (ids: readonly string[], byId: (id: string) => FleetAgent | undefined): string[] => [
        ...new Set(
            ids.flatMap((id) => {
                const card = byId(id);
                return card === undefined ? [id] : familyIds(card);
            }),
        ),
    ];
    return { archivedCards, childrenOf, cardOf, answers, selectedCard, toggleTray, trayState, trayFor, familyOf, familyIds, withFamilies };
};
