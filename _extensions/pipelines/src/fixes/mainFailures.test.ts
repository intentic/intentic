import {
    type AgentSummary,
    type CiMainFailure,
    ciFixConversationId,
    fixAttemptId,
    fixStance,
    type MainFailureDecision,
} from "@intentic/sandbox-contract";
import {
    coveredRuns,
    handBackOf,
    jobsAtAGlance,
    leadsRows,
    mainFailuresOf,
    type MainFailureState,
    mainFailureState,
    offersFix,
    storyOf,
    waitsForYou,
} from "./mainFailures";
import { agentCard, pipelineRun } from "../testing";

// A failing main line as the board says it above a repository's runs. The fixer is joined by the id the daemon names,
// never by a run's derived id: it was started with the first failed run, and every later failed run on main derives an
// id of its own.

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

const failing = (over: Partial<CiMainFailure> = {}): CiMainFailure => ({
    repo: `web`,
    branch: `main`,
    since: NOW - 30 * MINUTE,
    runId: 43,
    jobs: [`unit`, `typecheck`],
    ...over,
});

const decided = (kind: MainFailureDecision["kind"], over: Partial<MainFailureDecision> = {}): MainFailureDecision => ({
    kind,
    at: NOW - 10 * MINUTE,
    ...over,
});

describe(`mainFailureState`, () => {
    it(`is the owner's once the fix agent's turns are spent, or when repairs are off`, () => {
        expect(mainFailureState(failing({ fixer: `ci-fix-web-41`, decision: decided(`spent`) }))).toBe(`waits`);
        expect(mainFailureState(failing({ decision: decided(`reported`) }))).toBe(`reported`);
    });

    it(`is the fix agent's while one is named or was started, and nobody's before the daemon decided`, () => {
        expect(mainFailureState(failing({ fixer: `ci-fix-web-41`, decision: decided(`fix-up`) }))).toBe(`fixing`);
        expect(mainFailureState(failing({ fixer: `ci-fix-web-41` }))).toBe(`fixing`);
        expect(mainFailureState(failing({ decision: decided(`fix-up`) }))).toBe(`fixing`);
        expect(mainFailureState(failing())).toBe(`unassigned`);
    });
});

describe(`waitsForYou`, () => {
    it(`is true only for the two waits`, () => {
        const states: MainFailureState[] = [`waits`, `reported`, `fixing`, `unassigned`];
        expect(states.map((state) => waitsForYou({ state }))).toEqual([true, true, false, false]);
    });
});

describe(`handBackOf`, () => {
    it(`is the daemon's reason on a hand-back, never its sentence`, () => {
        const failure = failing({ decision: decided(`spent`, { reason: `turn-failed`, detail: `Its fix agent's turn failed.` }) });
        expect(handBackOf({ failure, state: mainFailureState(failure) })).toBe(`turn-failed`);
    });

    // A daemon from before the reason was recorded wrote the turn's whole error into `detail`: nothing reads it back.
    it(`is nothing for a hand-back without a reason, or a failure nobody handed back`, () => {
        const old = failing({ decision: decided(`spent`, { detail: `its fix agent's turn failed (Sandbox memory is low: …)` }) });
        expect(handBackOf({ failure: old, state: mainFailureState(old) })).toBeUndefined();
        const working = failing({ fixer: `ci-fix-web-41`, decision: decided(`fix-up`, { reason: `turns` }) });
        expect(handBackOf({ failure: working, state: mainFailureState(working) })).toBeUndefined();
    });
});

describe(`jobsAtAGlance`, () => {
    it(`spells a few jobs and folds the rest`, () => {
        const six = [`quick`, `front-check`, `verify-core`, `verify-clocks`, `perf-browser`, `lint`];
        expect(jobsAtAGlance(six)).toEqual({ shown: six.slice(0, 3), folded: six.slice(3) });
    });

    it(`never folds a single job, since "+1 more" costs what its name would`, () => {
        const four = [`a`, `b`, `c`, `d`];
        expect(jobsAtAGlance(four)).toEqual({ shown: four, folded: [] });
        expect(jobsAtAGlance([])).toEqual({ shown: [], folded: [] });
    });
});

describe(`mainFailuresOf`, () => {
    const first = ciFixConversationId(`web`, 41);

    // The whole point of `fixer`: a later failed run's derived id names whoever was pressed onto that run, not main's agent.
    it(`joins the fixer by the id the failure names, not by the newest failed run's`, () => {
        const pressedOnNewest = agentCard(ciFixConversationId(`web`, 43), { status: `idle` });
        const [view] = mainFailuresOf([failing({ fixer: first })], [pressedOnNewest, agentCard(first)], []);
        expect(view?.fixer?.id).toBe(first);
        expect(view?.stance).toMatchObject({ kind: `working`, label: `Agent working` });
    });

    it(`speaks for the fixer's newest attempt, since starting over files the earlier one away`, () => {
        const [view] = mainFailuresOf([failing({ fixer: first })], [agentCard(first, { status: `stopped` }), agentCard(fixAttemptId(first, 2))], []);
        expect(view?.fixer?.id).toBe(fixAttemptId(first, 2));
    });

    it(`still says a fixer is on it when the fleet no longer carries its conversation`, () => {
        const [view] = mainFailuresOf([failing({ fixer: first, decision: decided(`fix-up`) })], [], []);
        expect(view).toMatchObject({ state: `fixing`, fixer: undefined, stance: undefined });
    });

    it(`reads the fixer that finished without a fix as handed back once the daemon says so`, () => {
        const [view] = mainFailuresOf(
            [failing({ fixer: first, decision: decided(`spent`, { reason: `no-change` }) })],
            [agentCard(first, { status: `idle` })],
            [],
        );
        expect(view).toMatchObject({ state: `waits`, stance: { kind: `ended`, label: `Nothing changed` } });
        expect(view === undefined ? undefined : handBackOf(view)).toBe(`no-change`);
    });

    it(`finds the newest failed run it names in its own repository only`, () => {
        const mine = pipelineRun({ runId: 43 });
        const theirs = pipelineRun({ runId: 43, repo: `api`, host: `gitlab`, project: `acme/shop-api` });
        const [view] = mainFailuresOf([failing()], [], [theirs, mine]);
        expect(view?.run).toBe(mine);
        expect(mainFailuresOf([failing({ runId: 99 })], [], [mine])[0]?.run).toBeUndefined();
    });

    it(`puts the longest-failing first, and is nothing from a daemon that keeps no failures`, () => {
        const views = mainFailuresOf([failing({ repo: `web`, since: NOW - MINUTE }), failing({ repo: `api`, since: NOW - 40 * MINUTE })], [], []);
        expect(views.map((view) => view.failure.repo)).toEqual([`api`, `web`]);
        expect(mainFailuresOf(undefined, [], [])).toEqual([]);
    });
});

describe(`offersFix`, () => {
    const run = pipelineRun({ runId: 43 });

    it(`offers the press once nobody works on it, on a run the board still lists`, () => {
        expect([`waits`, `reported`, `unassigned`].map((state) => offersFix({ state: state as MainFailureState, run }))).toEqual([true, true, true]);
        expect(offersFix({ state: `fixing`, run })).toBe(false);
        expect(offersFix({ state: `waits`, run: undefined })).toBe(false);
    });
});

describe(`leadsRows`, () => {
    const run = pipelineRun({ runId: 43 });

    it(`holds the branch's fix while an agent works on it or the banner offers the press, so no row offers a second`, () => {
        // The case behind two "Fix with agent" buttons on one breakage: the banner showed its agent working while the row
        // under it still offered to start one.
        expect(leadsRows({ state: `fixing`, run })).toBe(true);
        expect(leadsRows({ state: `fixing`, run: undefined })).toBe(true);
        const asking: readonly MainFailureState[] = [`waits`, `reported`, `unassigned`];
        expect(asking.map((state) => leadsRows({ state, run }))).toEqual([true, true, true]);
    });

    it(`leaves the rows their own press only when the banner has none to give and nobody is on it`, () => {
        expect(leadsRows({ state: `waits`, run: undefined })).toBe(false);
        expect(leadsRows({ state: `unassigned`, run: undefined })).toBe(false);
    });
});

describe(`coveredRuns`, () => {
    it(`is the branch's failures nothing has passed since, and its runs still going, in the board's order`, () => {
        const going = pipelineRun({ runId: 50, status: `running` });
        const newest = pipelineRun({ runId: 49 });
        const older = pipelineRun({ runId: 48 });
        const history = pipelineRun({ runId: 40 });
        const passed = pipelineRun({ runId: 45, status: `success` });
        const canceled = pipelineRun({ runId: 47, status: `canceled` });
        const feature = pipelineRun({ runId: 46, branch: `feat/x` });
        const otherRepo = pipelineRun({ runId: 44, repo: `api` });
        const runs = [going, newest, older, canceled, feature, passed, otherRepo, history];
        expect(coveredRuns(failing(), runs, new Map([[history, passed]]))).toEqual([going, newest, older]);
    });

    it(`covers nothing when the board no longer lists the branch's runs`, () => {
        expect(coveredRuns(failing(), [pipelineRun({ runId: 9, branch: `feat/x` })], new Map())).toEqual([]);
    });
});

describe(`storyOf`, () => {
    const fixing = (status: AgentSummary["status"], over: Partial<AgentSummary> = {}) => {
        const fixer = agentCard(`ci-fix-web-41`, { status, updatedAt: NOW - 5 * MINUTE, ...over });
        return { state: `fixing` as const, fixer, stance: fixStance(fixer) };
    };

    it(`follows the agent's live stance while it has the failure, not the fact that one was sent`, () => {
        expect(storyOf(fixing(`running`), [])).toBe(`working`);
        expect(storyOf(fixing(`ready`), [])).toBe(`ready`);
        expect(storyOf(fixing(`landed`), [])).toBe(`landed`);
        expect(storyOf(fixing(`awaiting`, { attention: { ...agentCard(`x`).attention, question: true } }), [])).toBe(`needsYou`);
        expect(storyOf(fixing(`stopped`), [])).toBe(`ended`);
        expect(storyOf({ state: `fixing`, fixer: undefined, stance: undefined }, [])).toBe(`working`);
    });

    it(`calls a landed fix measured once a run starts after it landed, and only then`, () => {
        const before = pipelineRun({ runId: 51, status: `running`, createdAt: NOW - 6 * MINUTE });
        const after = pipelineRun({ runId: 52, status: `running`, createdAt: NOW - 4 * MINUTE });
        expect(storyOf(fixing(`landed`), [before])).toBe(`landed`);
        expect(storyOf(fixing(`landed`), [after, before])).toBe(`proving`);
    });

    it(`is the failure's own state once nobody is working on it`, () => {
        const states = [`waits`, `reported`, `unassigned`] as const;
        expect(states.map((state) => storyOf({ state, fixer: undefined, stance: undefined }, []))).toEqual([`waits`, `reported`, `unassigned`]);
    });
});
