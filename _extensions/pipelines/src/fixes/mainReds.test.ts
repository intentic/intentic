import { type CiMainRed, ciFixConversationId, fixAttemptId, type RedDecision } from "@intentic/sandbox-contract";
import { mainRedsOf, type MainRedState, mainRedState, waitsForYou } from "./mainReds";
import { agentCard, pipelineRun } from "../testing";

// Main's red as the board says it above a repository's runs. The fixer is joined by the id the daemon names, never by a
// run's derived id: it was started at the first failed job, and every later red run on main derives an id of its own.

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

const red = (over: Partial<CiMainRed> = {}): CiMainRed => ({
    repo: `web`,
    branch: `main`,
    since: NOW - 30 * MINUTE,
    runId: 43,
    jobs: [`unit`, `typecheck`],
    ...over,
});

const decided = (kind: RedDecision["kind"]): RedDecision => ({ kind, at: NOW - 10 * MINUTE });

describe(`mainRedState`, () => {
    it(`is the owner's once the fix agent's turns are spent, or when repairs are off`, () => {
        expect(mainRedState(red({ fixer: `ci-fix-web-41`, decision: decided(`spent`) }))).toBe(`waits`);
        expect(mainRedState(red({ decision: decided(`reported`) }))).toBe(`reported`);
    });

    it(`is the fix agent's while one is named or was started, and nobody's before the daemon decided`, () => {
        expect(mainRedState(red({ fixer: `ci-fix-web-41`, decision: decided(`fix-up`) }))).toBe(`fixing`);
        expect(mainRedState(red({ fixer: `ci-fix-web-41` }))).toBe(`fixing`);
        expect(mainRedState(red({ decision: decided(`fix-up`) }))).toBe(`fixing`);
        expect(mainRedState(red())).toBe(`unassigned`);
    });
});

describe(`waitsForYou`, () => {
    it(`is true only for the two waits`, () => {
        const states: MainRedState[] = [`waits`, `reported`, `fixing`, `unassigned`];
        expect(states.map((state) => waitsForYou({ state }))).toEqual([true, true, false, false]);
    });
});

describe(`mainRedsOf`, () => {
    const first = ciFixConversationId(`web`, 41);

    // The whole point of `fixer`: a later red run's derived id names whoever was pressed onto that run, not main's agent.
    it(`joins the fixer by the id the red names, not by the newest red run's`, () => {
        const pressedOnNewest = agentCard(ciFixConversationId(`web`, 43), { status: `idle` });
        const [view] = mainRedsOf([red({ fixer: first })], [pressedOnNewest, agentCard(first)], []);
        expect(view?.fixer?.id).toBe(first);
        expect(view?.stance).toMatchObject({ kind: `working`, label: `Agent working` });
    });

    it(`speaks for the fixer's newest attempt, since starting over files the earlier one away`, () => {
        const [view] = mainRedsOf([red({ fixer: first })], [agentCard(first, { status: `stopped` }), agentCard(fixAttemptId(first, 2))], []);
        expect(view?.fixer?.id).toBe(fixAttemptId(first, 2));
    });

    it(`still says a fixer is on it when the fleet no longer carries its conversation`, () => {
        const [view] = mainRedsOf([red({ fixer: first, decision: decided(`fix-up`) })], [], []);
        expect(view).toMatchObject({ state: `fixing`, fixer: undefined, stance: undefined });
    });

    it(`reads the fixer that finished without a fix as handed back once the daemon says so`, () => {
        const [view] = mainRedsOf(
            [red({ fixer: first, decision: { ...decided(`spent`), detail: `It finished without changing anything.` } })],
            [agentCard(first, { status: `idle` })],
            [],
        );
        expect(view).toMatchObject({
            state: `waits`,
            stance: { kind: `ended`, label: `Nothing changed` },
            red: { decision: { detail: `It finished without changing anything.` } },
        });
    });

    it(`finds the newest red run it names in its own repository only`, () => {
        const mine = pipelineRun({ runId: 43 });
        const theirs = pipelineRun({ runId: 43, repo: `api`, host: `gitlab`, project: `acme/shop-api` });
        const [view] = mainRedsOf([red()], [], [theirs, mine]);
        expect(view?.run).toBe(mine);
        expect(mainRedsOf([red({ runId: 99 })], [], [mine])[0]?.run).toBeUndefined();
    });

    it(`puts the longest red first, and is nothing from a daemon that keeps no reds`, () => {
        const views = mainRedsOf([red({ repo: `web`, since: NOW - MINUTE }), red({ repo: `api`, since: NOW - 40 * MINUTE })], [], []);
        expect(views.map((view) => view.red.repo)).toEqual([`api`, `web`]);
        expect(mainRedsOf(undefined, [], [])).toEqual([]);
    });
});
