import "@intentic/testing/dom";
import type { AutomationApproval, WorkflowRun } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { type EffectScope, effectScope, ref, shallowRef } from "vue";
import { NO_ATTENTION } from "../../fleet/agentStatus";
import { type FleetAgent, laneGroups } from "../../fleet/useAgents-fleet";
import type { DropTarget } from "../laneDrop";
import { dropClass, laneHeads, useBoardLanes } from "./boardLanes";
import { ARCHIVE_PAGE, type BoardView, VIEW_START } from "./boardView";
import { foldChildren } from "./childFold";

// Pins what each lane draws and what the board says about it: Finished's window and the card it pins, the archive's page
// in Finished's place, runs above their lane and capped with it, a filter lifting the window but not the archive's page,
// and the counts (the tally, the tail rows, the empty screens) taken from those same rows.

const card = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    title: `agent ${id}`,
    status: `landed`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
    ...over,
});
// Newest first, as Finished sorts them: f0 is the most recent.
const finished = (count: number): FleetAgent[] => Array.from({ length: count }, (_unused, at) => card(`f${at}`, { updatedAt: 10_000 - at }));
const run = (runId: string, over: Partial<WorkflowRun> = {}): WorkflowRun =>
    ({
        runId,
        workflow: { id: `wf`, name: `Review ${runId}`, steps: [], maxParallel: 1 },
        state: `done`,
        startedAt: 1,
        steps: [],
        ...over,
    }) as WorkflowRun;
const ids = (agents: readonly FleetAgent[]): string[] => agents.map((agent) => agent.id);
const runIds = (runs: readonly WorkflowRun[]): string[] => runs.map((entry) => entry.runId);

const running: EffectScope[] = [];
afterEach(() => {
    for (const effects of running.splice(0)) {
        effects.stop();
    }
});

// A board over plain refs: the scope's output (its children folded under their cards, as boardScope folds them), a
// filter matching titles, a drag, the store's archive and the ring.
const boardOf = (
    fleet: FleetAgent[],
    over: { runs?: WorkflowRun[]; archivedRuns?: WorkflowRun[]; archived?: FleetAgent[]; held?: AutomationApproval[] } = {},
) => {
    const view = shallowRef<BoardView>(VIEW_START);
    const folded = foldChildren(laneGroups(fleet));
    const boardLanes = shallowRef(folded.lanes);
    const runs = [...(over.runs ?? []), ...(over.archivedRuns ?? [])];
    const scope = {
        boardLanes,
        boardChildren: shallowRef(folded.children),
        boardHosts: shallowRef(folded.hosts),
        boardRunRows: shallowRef(over.runs ?? []),
        archivedRunRows: shallowRef(over.archivedRuns ?? []),
        ledgerRunIds: shallowRef<ReadonlySet<string>>(new Set(runIds(runs))),
        scopedHeld: shallowRef(over.held ?? []),
    };
    const needle = ref(``);
    const active = ref(false);
    const partial = ref(false);
    const filter = {
        active,
        needle,
        matches: (agent: FleetAgent): boolean => !active.value || (agent.title ?? ``).includes(needle.value),
        archivedMatches: shallowRef<readonly FleetAgent[]>([]),
        sessionMatches: shallowRef<readonly unknown[]>([]),
        partial,
    };
    const drag = {
        dragging: ref(false),
        over: ref<DropTarget | undefined>(undefined),
        accepts: (target: DropTarget): boolean => target === `finished`,
    };
    const agents = { fleet: shallowRef(fleet), lanes: shallowRef(laneGroups(fleet)), archived: shallowRef(over.archived ?? []) };
    const selected = ref<string | undefined>(undefined);
    const effects = effectScope();
    running.push(effects);
    const lanes = effects.run(() => useBoardLanes({ view, scope, filter, drag, agents, selected }))!;
    const filterBy = (text: string): void => {
        needle.value = text;
        active.value = true;
    };
    return { lanes, view, scope, filter, drag, selected, filterBy };
};

describe(`Finished's window`, () => {
    it(`draws the newest six and folds the rest behind its tail row`, () => {
        const { lanes } = boardOf(finished(8));
        expect(ids(lanes.cardsFor(`finished`))).toEqual([`f0`, `f1`, `f2`, `f3`, `f4`, `f5`]);
        expect(lanes.hiddenFinished.value).toBe(2);
    });

    it(`keeps the card wearing the ring where the lane puts it, however far down`, () => {
        const { lanes, selected } = boardOf(finished(8));
        selected.value = `f7`;
        expect(ids(lanes.cardsFor(`finished`))).toEqual([`f0`, `f1`, `f2`, `f3`, `f4`, `f5`, `f7`]);
        expect(lanes.hiddenFinished.value).toBe(1);
    });

    it(`lifts for the lane's own expand and for a filter, since a result set must not hide its own matches`, () => {
        const { lanes, view, filterBy } = boardOf(finished(8));
        view.value = { ...VIEW_START, all: true };
        expect(lanes.cardsFor(`finished`)).toHaveLength(8);

        view.value = VIEW_START;
        filterBy(`agent f`);
        expect(lanes.cardsFor(`finished`)).toHaveLength(8);
        expect(lanes.matchTally.value).toBe(`8 of 8`);
    });

    it(`caps the lane's runs with its cards, and counts the ones it capped in the tail row`, () => {
        const runs = Array.from({ length: 8 }, (_unused, at) => run(`r${at}`));
        const { lanes } = boardOf(finished(6), { runs });
        expect(runIds(lanes.runsFor(`finished`))).toEqual([`r0`, `r1`, `r2`, `r3`, `r4`, `r5`]);
        expect(lanes.hiddenFinished.value).toBe(2);
    });
});

describe(`runs in their lanes`, () => {
    it(`puts a running run in Active, a failed one or one whose step waits on the reader in Attention`, () => {
        const waiting = card(`step`, {
            attention: { ...NO_ATTENTION, question: true },
            workflow: { runId: `asks`, name: `x`, step: `s`, index: 0, total: 1 },
        });
        const { lanes } = boardOf([waiting], {
            runs: [run(`live`, { state: `running` }), run(`broke`, { state: `failed` }), run(`asks`, { state: `running` })],
        });
        expect(runIds(lanes.runsFor(`active`))).toEqual([`live`]);
        expect(runIds(lanes.runsFor(`attention`))).toEqual([`broke`, `asks`]);
        expect(lanes.needingYou.value).toEqual(new Set([`asks`]));
    });

    it(`keeps a run under a query when its name, its request or one of its steps answers it`, () => {
        const { lanes, filterBy } = boardOf([], { runs: [run(`kept`, { request: `tidy the login page` }), run(`dropped`)] });
        filterBy(`login`);
        expect(runIds(lanes.runsFor(`finished`))).toEqual([`kept`]);
    });
});

describe(`the archive in Finished's place`, () => {
    const pile = Array.from({ length: 70 }, (_unused, at) =>
        card(`old${at}`, { archivedAt: 20_000 - at, title: at % 2 === 0 ? `even ${at}` : `odd ${at}` }),
    );

    it(`draws one page of its cards and its runs alone, the other lanes empty of runs`, () => {
        const { lanes, view } = boardOf([card(`live`)], {
            archived: pile,
            runs: [run(`now`, { state: `running` })],
            archivedRuns: [run(`filed`, { archivedAt: 3 })],
        });
        view.value = { ...VIEW_START, archive: true };
        expect(ids(lanes.cardsFor(`finished`))).toEqual(ids(pile.slice(0, ARCHIVE_PAGE)));
        expect(runIds(lanes.runsFor(`finished`))).toEqual([`filed`]);
        expect(lanes.runsFor(`active`)).toEqual([]);
        expect(lanes.archiveHidden.value).toBe(40);
        expect(lanes.archiveSize.value).toBe(71);
    });

    it(`filters the whole pile before paging it, and tallies the matches rather than the page`, () => {
        const { lanes, view, filterBy } = boardOf(finished(2), { archived: pile });
        view.value = { ...VIEW_START, archive: true };
        filterBy(`even`);
        expect(lanes.cardsFor(`finished`)).toHaveLength(ARCHIVE_PAGE);
        expect(lanes.archiveHidden.value).toBe(5);
        // Out of the board's own rows, whichever list stands in Finished.
        expect(lanes.matchTally.value).toBe(`35 of 2`);
    });

    it(`files a run's steps with their run: one row in the archive, not one per step`, () => {
        const steps = [`s1`, `s2`].map((id) => card(id, { archivedAt: 9, workflow: { runId: `filed`, name: `x`, step: id, index: 0, total: 2 } }));
        const { lanes } = boardOf([], { archived: [...steps, card(`loose`, { archivedAt: 8 })], archivedRuns: [run(`filed`, { archivedAt: 9 })] });
        expect(ids(lanes.archivedCards.value)).toEqual([`loose`]);
        expect(lanes.archiveSize.value).toBe(2);
    });
});

describe(`what the board says it holds`, () => {
    it(`asks for a first task while only an untouched draft is on the board`, () => {
        expect(boardOf([]).lanes.screen.value).toBe(`first`);
        expect(boardOf([card(`d`, { status: `draft` })]).lanes.screen.value).toBe(`first`);
    });

    it(`counts a held wake as something to show, and an archive as a history rather than a first run`, () => {
        const held = boardOf([], { held: [{ id: `w1`, automationId: `nightly`, createdAt: 1 }] });
        expect(held.lanes.screen.value).toBe(`lanes`);
        const cleared = boardOf([], { archived: [card(`old`, { archivedAt: 5 })] });
        expect(cleared.lanes.screen.value).toBe(`cleared`);
        cleared.view.value = { ...VIEW_START, archive: true };
        expect(cleared.lanes.screen.value).toBe(`lanes`);
    });

    it(`says the tally is incomplete while the daemon's half is out, and claims no empty result until it is in`, () => {
        const { lanes, filter, filterBy } = boardOf(finished(3));
        filterBy(`nothing like it`);
        expect(lanes.matchTally.value).toBe(`0 of 3`);
        expect(lanes.noMatches.value).toBe(true);

        filter.partial.value = true;
        expect(lanes.matchTally.value).toBe(`searching the rest…`);
        expect(lanes.noMatches.value).toBe(false);
    });

    it(`names what a query found off the board, leaving out a filed run's steps, and hides it while the archive is open`, () => {
        const { lanes, filter, view, filterBy } = boardOf([card(`a`)], { archivedRuns: [run(`filed`, { archivedAt: 1 })] });
        filterBy(`agent`);
        const step = card(`step`, { archivedAt: 1, workflow: { runId: `filed`, name: `x`, step: `s`, index: 0, total: 1 } });
        filter.archivedMatches.value = [card(`old`, { archivedAt: 1 }), step];
        filter.sessionMatches.value = [{ id: `s1` }, { id: `s2` }];
        expect(lanes.beyondLabel.value).toBe(`1 in the archive · 2 in earlier chats`);
        expect(lanes.beyondVisible.value).toBe(true);
        expect(lanes.noMatches.value).toBe(false);

        view.value = { ...VIEW_START, archive: true };
        expect(lanes.beyondVisible.value).toBe(false);
    });

    it(`offers Clear for exactly this sandbox's own Finished lane, and orders a Shift+click range left to right`, () => {
        const board = [card(`waits`, { attention: { ...NO_ATTENTION, question: true } }), card(`works`, { status: `running` }), ...finished(2)];
        const { lanes } = boardOf(board);
        expect(lanes.clearable.value).toBe(2);
        expect(ids(lanes.paneOrder.value)).toEqual([`waits`, `works`, `f0`, `f1`]);
    });
});

describe(`children riding under their parent`, () => {
    const parent = card(`p`, { status: `running`, startedAt: 1, title: `orchestrate the release` });
    const helper = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => card(id, { startedBy: `agent:p`, title: `helper ${id}`, ...over });

    it(`draws them under their parent's card rather than as cards of their own, and counts the family as one row`, () => {
        const { lanes } = boardOf([parent, helper(`h1`, { status: `running`, startedAt: 2 }), helper(`h2`), helper(`h3`)]);
        expect(ids(lanes.cardsFor(`active`))).toEqual([`p`]);
        expect(lanes.cardsFor(`finished`)).toEqual([]);
        expect(ids(lanes.childrenOf(parent))).toEqual([`h1`, `h2`, `h3`]);
        expect(lanes.cardOf(helper(`h2`)).id).toBe(`p`);
        expect(lanes.matchTally.value).toBe(`1 of 1`);
    });

    it(`keeps a parent under a query one of its children answered, with that child alone in its tray`, () => {
        const { lanes, filterBy } = boardOf([parent, helper(`h1`, { title: `port the parser` }), helper(`h2`), card(`else`)]);
        filterBy(`parser`);
        expect(ids(lanes.cardsFor(`active`))).toEqual([`p`]);
        expect(ids(lanes.cardsFor(`finished`))).toEqual([]);
        expect(ids(lanes.trayFor(parent)?.lead ?? [])).toEqual([`h1`]);
    });

    it(`keeps the card a ringed child rides under in Finished's window`, () => {
        const done = card(`p`, { updatedAt: 1 });
        const { lanes, selected } = boardOf([...finished(6), done, helper(`h1`)]);
        expect(ids(lanes.cardsFor(`finished`))).not.toContain(`p`);
        selected.value = `h1`;
        expect(ids(lanes.cardsFor(`finished`))).toContain(`p`);
        expect(ids(lanes.trayFor(done)?.tail ?? [])).toEqual([`h1`]);
    });

    it(`walks a Shift+click range through the rows a tray draws, and not through the ones it folds`, () => {
        const { lanes } = boardOf([parent, helper(`h1`, { status: `running`, startedAt: 2 }), helper(`h2`), card(`after`)]);
        expect(ids(lanes.paneOrder.value)).toEqual([`p`, `h1`, `after`]);
        lanes.toggleTray(parent);
        expect(ids(lanes.paneOrder.value)).toEqual([`p`, `h1`, `h2`, `after`]);
    });

    it(`files and brings back a card with its settled children, never one still working`, () => {
        const busy = helper(`h1`, { status: `running`, startedAt: 2 });
        const { lanes } = boardOf([parent, busy, helper(`h2`)]);
        expect(lanes.familyIds(parent)).toEqual([`p`, `h2`]);
        expect(lanes.familyIds(busy)).toEqual([`h1`]);
        expect(lanes.withFamilies([`p`, `h2`], (id) => [parent, busy].find((agent) => agent.id === id))).toEqual([`p`, `h2`]);
    });

    it(`leaves a working parent's settled children out of Clear, and clears a finished parent's with it`, () => {
        const done = card(`done`);
        const { lanes } = boardOf([parent, helper(`h1`), done, card(`d1`, { startedBy: `agent:done` })]);
        expect(lanes.clearable.value).toBe(2);
    });

    it(`hangs filed children under their filed parent in the archive, one row for the family`, () => {
        const filed = [card(`p`, { archivedAt: 9 }), helper(`h1`, { archivedAt: 8, status: `ready` }), helper(`h2`, { archivedAt: 7 })];
        const { lanes, view } = boardOf([], { archived: filed });
        view.value = { ...VIEW_START, archive: true };
        expect(ids(lanes.cardsFor(`finished`))).toEqual([`p`]);
        expect(lanes.archiveSize.value).toBe(1);
        expect(lanes.familyIds(filed[0]!)).toEqual([`p`, `h1`, `h2`]);
    });
});

describe(`a lane under a dragged card`, () => {
    it(`says nothing until a card is in flight, then whether it takes the card and whether the card is over it`, () => {
        const { lanes, drag, view } = boardOf([]);
        expect(lanes.laneDropClass(`finished`)).toBe(``);
        drag.dragging.value = true;
        expect(lanes.laneDropClass(`finished`)).toBe(`min-h-24 ring-1 ring-line-strong/60`);
        drag.over.value = `finished`;
        expect(lanes.laneDropClass(`finished`)).toBe(`min-h-24 bg-primary-600/5 ring-2 ring-primary-500/60`);
        expect(lanes.laneDropClass(`active`)).toBe(`min-h-24 opacity-40`);
        view.value = { ...VIEW_START, archive: true };
        expect(lanes.laneDropClass(`finished`)).toBe(`min-h-24 opacity-40`);
    });

    it(`never advertises the archive as a lane, even where the card would be taken`, () => {
        expect(dropClass(`finished`, { accepts: true, archive: true, over: `finished` })).toBe(`min-h-24 opacity-40`);
        expect(dropClass(`active`, { accepts: true, archive: true, over: `active` })).toBe(`min-h-24 bg-primary-600/5 ring-2 ring-primary-500/60`);
    });
});

describe(`the lanes' heads`, () => {
    it(`runs Attention, Active, Finished, each with its dot and what it says empty`, () => {
        expect(laneHeads()).toEqual([
            { key: `attention`, label: t(`shared.attention`), dot: `bg-warning`, empty: t(`agents.agentsView.nothingNeedsRightNow`) },
            { key: `active`, label: t(`shared.active`), dot: `bg-success`, empty: t(`agents.agentsView.noAgentsWorkingStart`) },
            { key: `finished`, label: t(`shared.finished`), dot: `bg-line-strong`, empty: t(`agents.agentsView.finishedAgentsLandWork`) },
        ]);
    });
});
