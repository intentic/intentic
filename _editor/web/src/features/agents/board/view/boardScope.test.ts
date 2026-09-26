import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { AutomationApproval, Persona, WorkflowRun } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { type EffectScope, effectScope, nextTick, ref, shallowRef } from "vue";
import { projectScope } from "../../../../app/projectScope";
import { NO_ATTENTION } from "../../fleet/agentStatus";
import { type FleetAgent, laneGroups } from "../../fleet/useAgents-fleet";
import { ownerFilter, ownerLook } from "../ownership";
import { hiddenByProject, ownerSegments, scopeFleet, useBoardScope, withoutSteps } from "./boardScope";

// Pins which of the fleet the board covers: a project keeps the conversations with evidence of belonging and every
// unsent draft, an owner keeps theirs (drafts only under Mine or everybody's), a run's steps never stand as cards, and
// the chip counts rows the project hid, a run and its steps once.

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
const run = (runId: string, over: Partial<WorkflowRun> = {}): WorkflowRun =>
    ({ runId, workflow: { id: `wf`, name: `Review`, steps: [], maxParallel: 1 }, state: `running`, startedAt: 1, steps: [], ...over }) as WorkflowRun;
const wake = (id: string, conversationId?: string): AutomationApproval => ({ id, automationId: `nightly`, createdAt: 1_000, conversationId });
const step = (id: string, runId: string): FleetAgent =>
    card(id, { startIn: `shop`, workflow: { runId, name: `Review`, step: `first`, index: 0, total: 1 } });

const ME = `me@example.com`;
const ADA = `ada@example.com`;
const inShop = card(`shop`, { startIn: `shop`, owner: { email: ADA, since: 1 } });
const elsewhere = card(`api`, { startIn: `api`, owner: { email: ME, since: 1 } });
const draft = card(`draft`, { status: `draft` });

const running: EffectScope[] = [];

beforeEach(() => {
    localStorage.clear();
    resetSandboxScope();
});

afterEach(() => {
    for (const effects of running.splice(0)) {
        effects.stop();
    }
});

describe(`which cards the scope keeps`, () => {
    const fleet = [inShop, elsewhere, draft];
    const everything = { project: undefined, owner: undefined, me: ME, personas: [] };

    it(`keeps a project's own conversations and every unsent draft, opened under it with no record to say so`, () => {
        expect(scopeFleet(fleet, { ...everything, project: `shop` }).map((agent) => agent.id)).toEqual([`shop`, `draft`]);
        expect(scopeFleet(fleet, everything)).toEqual(fleet);
    });

    it(`keeps the reader's own and the drafts under Mine, and only the colleague's under their chip`, () => {
        expect(scopeFleet(fleet, { ...everything, owner: ME }).map((agent) => agent.id)).toEqual([`api`, `draft`]);
        expect(scopeFleet(fleet, { ...everything, owner: ADA }).map((agent) => agent.id)).toEqual([`shop`]);
    });

    it(`narrows by project and owner together`, () => {
        expect(scopeFleet(fleet, { ...everything, project: `api`, owner: ADA })).toEqual([]);
    });
});

describe(`a run's steps`, () => {
    it(`come off every lane while their run is in the ledger, and the lanes are handed back as they are when none is`, () => {
        const lanes = laneGroups([step(`s1`, `r1`), card(`a1`), card(`a2`, { status: `running` })]);
        expect(withoutSteps(lanes, new Set())).toBe(lanes);
        const kept = withoutSteps(lanes, new Set([`r1`]));
        const ids = (lane: readonly FleetAgent[]): string[] => lane.map((agent) => agent.id);
        expect({ attention: ids(kept.attention), active: ids(kept.active), finished: ids(kept.finished) }).toEqual({
            attention: [],
            active: [`a2`],
            finished: [`a1`],
        });
    });
});

describe(`what the project chip says it hid`, () => {
    it(`counts hidden rows, a run and its steps once, and nothing without a project`, () => {
        const board = {
            project: `shop`,
            fleet: [inShop, elsewhere, step(`s1`, `r1`), card(`loose`, { startIn: `docs` })],
            kept: [inShop],
            ledger: new Set([`r1`, `r2`]),
            runs: [run(`r1`), run(`r2`), run(`gone`, { archivedAt: 9 })],
            keptRuns: [run(`r1`)],
            held: [wake(`w1`), wake(`w2`)],
            keptHeld: [wake(`w1`)],
        };
        // `api` and `loose` as cards, `r2` as a row (its step `s1` hid with the ledger), `w2` as a hold.
        expect(hiddenByProject(board)).toBe(4);
        expect(hiddenByProject({ ...board, project: undefined })).toBe(0);
    });

    it(`counts a hidden parent and the children riding under it once, as the board would draw them`, () => {
        const parent = card(`lead`, { startIn: `docs` });
        const children = [`c1`, `c2`, `c3`].map((id) => card(id, { startIn: `docs`, startedBy: `agent:lead` }));
        const board = { project: `shop`, fleet: [inShop, parent, ...children], kept: [inShop], ledger: new Set<string>(), runs: [], keptRuns: [], held: [], keptHeld: [] };
        expect(hiddenByProject(board)).toBe(1);
    });
});

describe(`the owner segments`, () => {
    it(`offers everybody's, the reader's own, then each other owner by name`, () => {
        expect(ownerSegments(ME, [ownerLook({ email: ADA, name: `Ada Lovelace` }, ME, [])])).toEqual([
            { label: t(`agents.agentsView.everyone`), value: `everyone`, title: t(`agents.agentsView.mineOff`) },
            { label: t(`agents.agentsView.mine`), value: ME, title: t(`agents.agentsView.mineOnly`) },
            {
                label: `Ada`,
                value: ADA,
                hue: ownerLook({ email: ADA }, ME, []).hue,
                title: t(`agents.agentsView.onlyOwnedBy`, { name: `Ada Lovelace` }),
            },
        ]);
        expect(ownerSegments(undefined, []).map((segment) => segment.value)).toEqual([`everyone`]);
    });
});

describe(`the board's scope`, () => {
    const scopeOf = (fleet: FleetAgent[], over: { runs?: WorkflowRun[]; held?: AutomationApproval[]; personas?: Persona[] } = {}) => {
        const agents = { fleet: shallowRef(fleet), lanes: shallowRef(laneGroups(fleet)), heldWakes: shallowRef(over.held ?? []) };
        const sharedAccess = ref(true);
        const effects = effectScope();
        running.push(effects);
        const scope = effects.run(() =>
            useBoardScope({ agents, runs: shallowRef(over.runs ?? []), personas: shallowRef(over.personas ?? []), me: ref(ME), sharedAccess }),
        )!;
        return { agents, sharedAccess, scope };
    };

    it(`draws the store's own lanes while nothing narrows the board, and regroups what a project keeps`, () => {
        const { agents, scope } = scopeOf([inShop, elsewhere]);
        expect(scope.boardLanes.value).toBe(agents.lanes.value);

        projectScope.value = `shop`;

        expect(scope.boardLanes.value).toEqual({ attention: [], active: [], finished: [inShop] });
        expect(scope.projectHidden.value).toBe(1);
    });

    it(`hangs a child under the card that started it, off the lanes and into that card's tray`, () => {
        const lead = card(`lead`, { status: `running`, startedAt: 1 });
        const helper = card(`helper`, { startedBy: `agent:lead` });
        const { scope } = scopeOf([lead, helper, elsewhere]);
        expect(scope.boardLanes.value).toEqual({ attention: [], active: [lead], finished: [elsewhere] });
        expect(scope.boardChildren.value.get(`lead`)).toEqual([helper]);
        expect(scope.boardHosts.value.get(`helper`)).toBe(lead);
    });

    it(`narrows held wakes and live runs by the project's evidence, and leaves the archive the sandbox's`, () => {
        const runs = [run(`r1`), run(`r2`), run(`old`, { archivedAt: 5 })];
        const { scope } = scopeOf([inShop, step(`s1`, `r1`)], { runs, held: [wake(`w1`, `shop`), wake(`w2`)] });
        projectScope.value = `shop`;

        expect(scope.scopedHeld.value.map((entry) => entry.id)).toEqual([`w1`]);
        expect(scope.boardRunRows.value.map((row) => row.runId)).toEqual([`r1`]);
        expect(scope.archivedRunRows.value.map((row) => row.runId)).toEqual([`old`]);
        expect(scope.ledgerRunIds.value).toEqual(new Set([`r1`, `r2`, `old`]));
        // The run's step lives inside its row.
        expect(scope.boardLanes.value.finished).toEqual([inShop]);
    });

    it(`reads and writes the owner filter through one segment, Everyone standing for none`, () => {
        const { scope } = scopeOf([inShop, elsewhere]);
        expect(scope.ownerScope.value).toBe(`everyone`);

        scope.ownerScope.value = ADA;
        expect(ownerFilter.value).toBe(ADA);
        expect(scope.boardLanes.value).toEqual({ attention: [], active: [], finished: [inShop] });

        scope.ownerScope.value = `everyone`;
        expect(ownerFilter.value).toBeUndefined();
    });

    it(`offers a chip per colleague holding work here, and the two scopes by name`, () => {
        const { scope } = scopeOf([inShop, elsewhere]);
        expect(scope.ownerOptions.value.map((option) => option.value)).toEqual([`everyone`, ME, ADA]);
        expect(scope.scopeOptions.value).toEqual([
            { label: t(`shared.thisSandbox`), value: `box` },
            { label: t(`agents.agentsView.allSandboxes`), value: `all` },
        ]);
    });

    it(`drops the owner filter once nobody else can hold work here`, async () => {
        const { scope, sharedAccess } = scopeOf([inShop]);
        scope.ownerScope.value = ADA;

        sharedAccess.value = false;
        await nextTick();

        expect(ownerFilter.value).toBeUndefined();
    });
});
