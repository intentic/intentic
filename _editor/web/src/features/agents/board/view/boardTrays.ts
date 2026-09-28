import type { SubagentSession } from "@intentic/sandbox-contract";
import { computed, type Ref, shallowRef } from "vue";
import type { SubagentRoster } from "../../fleet/subagentRoster";
import { familyChip, type StandingChip } from "../../fleet/agentStatus";
import { canArchive, type FleetAgent, withKeptWords } from "../../fleet/useAgents-fleet";
import { insideRun } from "../../fleet/useWorkflowRuns";
import {
    ARCHIVE_RULES,
    cardKey,
    type ChildFold,
    FINISHED_FOLD,
    foldChildren,
    steadyFold,
    subagentTitle,
    type Tray,
    trayOf,
    type TrayState,
} from "./childFold";

// The children riding under the board's cards (childFold), as the lanes read them: whose tray a child is in, what a tray
// draws against the board's filter, ring and folds, what a card says for the children calling the reader through it,
// and the archive's own fold, whose filed children ride under their filed parent exactly as live ones do on the board.
// A tray holds the subagents a card's runtime ran in-process too, from the roster, beside the conversations it spawned.

export interface TraysHost {
    // What the scope folded (boardScope): the children under each card, the card each child is under, and the children
    // calling the reader through each card.
    readonly scope: {
        readonly boardChildren: Readonly<Ref<ReadonlyMap<string, readonly FleetAgent[]>>>;
        readonly boardHosts: Readonly<Ref<ReadonlyMap<string, FleetAgent>>>;
        readonly boardCalls: Readonly<Ref<ReadonlyMap<string, readonly FleetAgent[]>>>;
        readonly ledgerRunIds: Readonly<Ref<ReadonlySet<string>>>;
    };
    // The store's archive, as read so far.
    readonly archived: Readonly<Ref<readonly FleetAgent[]>>;
    readonly filter: {
        readonly active: Readonly<Ref<boolean>>;
        // The query as the filter reads it, folded to lower case unless `matchCase` is on.
        readonly needle: Readonly<Ref<string>>;
        readonly matchCase: Readonly<Ref<boolean>>;
        readonly matches: (agent: FleetAgent) => boolean;
    };
    // The sandbox's subagent roster: the ones a conversation's runtime ran in-process, by conversation.
    readonly roster: Pick<SubagentRoster, "inProcessOf">;
    // The card wearing the ring.
    readonly selected: Readonly<Ref<string | undefined>>;
}

const NONE_OPEN: ReadonlySet<string> = new Set<string>();
const NO_SUBAGENTS: readonly SubagentSession[] = [];

export const useBoardTrays = (host: TraysHost) => {
    const { scope, filter } = host;
    // A run's steps are filed away with the run, or the archive would show one run row plus its five conversations. A
    // parent's children ride under its card there too, every one of them: nothing in the archive asks for a press.
    const archiveFold = computed<ChildFold>((previous) => {
        const filed = host.archived.value.filter((agent) => !insideRun(agent, scope.ledgerRunIds.value)).map(withKeptWords);
        return steadyFold(previous, foldChildren({ attention: [], active: [], finished: filed }, ARCHIVE_RULES));
    });
    const archivedCards = computed(() => archiveFold.value.lanes.finished);
    // What rides under a card: the archive's own fold for a filed card, the board's for one on it.
    const childrenOf = (card: FleetAgent): readonly FleetAgent[] =>
        (card.archivedAt === undefined ? scope.boardChildren.value : archiveFold.value.children).get(cardKey(card)) ?? [];
    // The card a child is drawn under, if it rides under one; a card stands for itself.
    const cardOf = (agent: FleetAgent): FleetAgent =>
        (agent.archivedAt === undefined ? scope.boardHosts.value : archiveFold.value.hosts).get(cardKey(agent)) ?? agent;
    // What a card says for the children calling the reader through it, one chip per calling list: the fold keeps a list
    // while its members stand still (steadyFold), so the chip, and the card memoised on it, stay put with it.
    const callChips = computed(() => {
        const chips = new Map<string, StandingChip & { readonly hint: string }>();
        for (const [key, calls] of scope.boardCalls.value) {
            const chip = familyChip(calls);
            if (chip !== undefined) {
                chips.set(key, chip);
            }
        }
        return chips;
    });
    const callOf = (card: FleetAgent): (StandingChip & { readonly hint: string }) | undefined =>
        card.archivedAt === undefined ? callChips.value.get(cardKey(card)) : undefined;
    // What a card's runtime ran in-process, which the roster holds for this sandbox's cards alone: another box's card has
    // its own daemon's roster, which this board does not read.
    const subagentsOf = (card: FleetAgent): readonly SubagentSession[] =>
        card.sandboxId === undefined ? host.roster.inProcessOf(card.id) : NO_SUBAGENTS;
    // Only its title can answer a query, having no transcript the filter's index reads, under the filter's own case rule.
    const subagentMatches = (session: SubagentSession): boolean => {
        if (!filter.active.value) {
            return true;
        }
        const title = subagentTitle(session) ?? ``;
        return (filter.matchCase.value ? title : title.toLowerCase()).includes(filter.needle.value);
    };
    // A card stays under a query when it or anything riding under it matched, as a run answers for its steps: a child
    // has no card of its own to answer with, and its parent's is where the reader goes looking for it.
    const answers = (card: FleetAgent): boolean =>
        filter.matches(card) || childrenOf(card).some(filter.matches) || subagentsOf(card).some(subagentMatches);
    // The ring on a child keeps the card it rides under in Finished's window, or the ring would be on nothing drawn.
    const selectedCard = computed(() => {
        const id = host.selected.value;
        return id === undefined ? undefined : (scope.boardHosts.value.get(id)?.id ?? id);
    });
    // The folds the reader opened, by card: its settled children, or a group of children stopped on one thing. The
    // board's own, not remembered: a fold reopened after a visit elsewhere would bury the lane under a list the reader
    // had finished with.
    const openTrays = shallowRef<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
    const toggleTray = (card: FleetAgent, fold: string = FINISHED_FOLD): void => {
        const key = cardKey(card);
        const opened = new Set(openTrays.value.get(key));
        if (!opened.delete(fold)) {
            opened.add(fold);
        }
        const next = new Map(openTrays.value);
        if (opened.size === 0) {
            next.delete(key);
        } else {
            next.set(key, opened);
        }
        openTrays.value = next;
    };
    // The folds, the filter and the ring, as they bear on one card's tray.
    const trayState = (card: FleetAgent): TrayState => ({
        opened: openTrays.value.get(cardKey(card)) ?? NONE_OPEN,
        asking: card.archivedAt === undefined,
        filtering: filter.active.value,
        matches: filter.matches,
        matchesSubagent: subagentMatches,
        selected: host.selected.value,
    });
    // What a card's tray draws (childFold.trayOf).
    const trayFor = (card: FleetAgent): Tray | undefined => trayOf(childrenOf(card), trayState(card), subagentsOf(card));
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
    return {
        archivedCards,
        childrenOf,
        subagentsOf,
        cardOf,
        callOf,
        answers,
        selectedCard,
        toggleTray,
        trayState,
        trayFor,
        familyOf,
        familyIds,
        withFamilies,
    };
};
