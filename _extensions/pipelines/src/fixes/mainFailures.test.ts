import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { type CiMainFailure, MAIN_FAILURE_STALE_MS, type MainFailureDecision } from "@intentic/sandbox-contract/schemas/ci";
import { ciFixConversationId, fixAttemptId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { fixStance } from "@intentic/sandbox-contract/state/fix-stance";
import {
    blockerOf,
    coveredRuns,
    failingSince,
    failingWorkflowsOf,
    handBackOf,
    jobsAtAGlance,
    leadsRows,
    mainFailuresOf,
    type MainFailureState,
    mainFailureState,
    offersFix,
    QUIET_AFTER_MS,
    stalls,
    storyOf,
    waitsForYou,
    workflowOfRun,
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
        const six = [`quick`, `netd-check`, `verify-core`, `verify-clocks`, `perf-browser`, `lint`];
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

    it.each([`queued`, `running`, `failed`] as const)(`offers a new fix for known failures after landing while the run is %s`, (status) => {
        const fixer = agentCard(first, { status: `landed`, updatedAt: NOW - 5 * MINUTE });
        const run = pipelineRun({ runId: 43, status, createdAt: NOW - 4 * MINUTE });
        const [view] = mainFailuresOf([failing({ fixer: first })], [fixer], [run]);
        expect(view?.state).toBe(`failed-again`);
        expect(view === undefined ? false : offersFix(view)).toBe(true);
        expect(view === undefined ? undefined : storyOf(view, [run])).toBe(status === `failed` ? `failed-again` : `collecting`);
    });

    it(`keeps the landed state for old failures, a healthy newer run, and an attempt still working`, () => {
        const fixer = agentCard(first, { status: `landed`, updatedAt: NOW - 5 * MINUTE });
        const old = pipelineRun({ runId: 43, createdAt: fixer.updatedAt });
        const healthy = pipelineRun({ runId: 44, status: `running`, createdAt: NOW - 4 * MINUTE });
        const [view] = mainFailuresOf([failing({ fixer: first })], [fixer], [healthy, old]);
        expect(view?.state).toBe(`fixing`);
        expect(view === undefined ? true : offersFix(view)).toBe(false);
        expect(view === undefined ? undefined : storyOf(view, [healthy, old])).toBe(`proving`);
        const [working] = mainFailuresOf([failing({ fixer: first })], [agentCard(first)], [healthy, old]);
        expect(working?.state).toBe(`fixing`);
        expect(working === undefined ? true : offersFix(working)).toBe(false);
    });

    it.each([`success`, `canceled`, `skipped`] as const)(`does not revive a failure whose named run is now %s`, (status) => {
        const fixer = agentCard(first, { status: `landed`, updatedAt: NOW - 5 * MINUTE });
        const run = pipelineRun({ runId: 43, status, createdAt: NOW - 4 * MINUTE });
        expect(mainFailuresOf([failing({ fixer: first })], [fixer], [run])[0]?.state).toBe(`fixing`);
    });

    // A failure that has been open for weeks over a nightly says when each workflow began, and the block is ordered by
    // the longest-failing workflow it holds now, not by when the failure first opened.
    it(`orders by the longest-failing workflow it holds, where the daemon times them apart`, () => {
        const ci = failing({ repo: `web`, since: NOW - 40 * MINUTE, workflows: [{ name: `CI`, runId: 43, jobs: [`unit`], since: NOW - 2 * MINUTE }] });
        const api = failing({ repo: `api`, since: NOW - 10 * MINUTE });
        expect(mainFailuresOf([ci, api], [], []).map((view) => view.failure.repo)).toEqual([`api`, `web`]);
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

    it(`keeps the renewed failure's only fix control in the banner`, () => {
        expect(offersFix({ state: `failed-again`, run })).toBe(true);
        expect(leadsRows({ state: `failed-again`, run })).toBe(true);
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

    // A nightly's failure sits on a commit whose later neighbours passed CI: the board's per-commit "superseded" files it
    // away, while the daemon, which tracks each workflow apart, still says main fails in it.
    it(`keeps a failure the daemon names inside the block, whatever passed on a later commit`, () => {
        const nightly = pipelineRun({ runId: 30, workflow: `Nightly` });
        const ciPassed = pipelineRun({ runId: 31, status: `success` });
        const oldCi = pipelineRun({ runId: 29 });
        const named = failing({ workflows: [{ name: `Nightly`, runId: 30, jobs: [`smoke`] }] });
        const superseded = new Map([
            [nightly, ciPassed],
            [oldCi, ciPassed],
        ]);
        expect(coveredRuns(named, [ciPassed, nightly, oldCi], superseded)).toEqual([nightly]);
        expect(coveredRuns(failing(), [ciPassed, nightly, oldCi], superseded)).toEqual([]);
    });

    // GitHub shows a workflow's newest run as its state: a cancelled run after the failure is why nothing measured it, and
    // a block without it disagreed with the forge's own page about what main is doing.
    it(`draws a failing workflow's newest run when it was cancelled after the failure, and no other cancelled run`, () => {
        const failed = pipelineRun({ runId: 43, workflow: `CI` });
        const cancelled = pipelineRun({ runId: 60, workflow: `CI`, status: `canceled` });
        const olderCancel = pipelineRun({ runId: 41, workflow: `CI`, status: `canceled` });
        const otherWorkflow = pipelineRun({ runId: 61, workflow: `Scorecard`, status: `canceled` });
        const named = failing({ workflows: [{ name: `CI`, runId: 43, jobs: [`unit`] }] });
        const runs = [otherWorkflow, cancelled, failed, olderCancel];
        expect(coveredRuns(named, runs, new Map())).toEqual([cancelled, failed]);
        // Once a later run of it goes, that run is the measurement, and the cancelled one is history again.
        const going = pipelineRun({ runId: 62, workflow: `CI`, status: `running` });
        expect(coveredRuns(named, [going, ...runs], new Map())).toEqual([going, failed]);
    });

    it(`covers nothing when the board no longer lists the branch's runs`, () => {
        expect(coveredRuns(failing(), [pipelineRun({ runId: 9, branch: `feat/x` })], new Map())).toEqual([]);
    });
});

describe(`failingWorkflowsOf`, () => {
    const repo = { host: `github` as const, url: `https://github.com/acme/web` };
    const workflows = [
        { name: `Nightly`, runId: 30, jobs: [`desktop-windows / smoke`] },
        { name: `CI`, runId: 52, jobs: [`changes`] },
    ];

    it(`names each workflow with its jobs, linked to the listed run or, off the board, to the forge's page for it`, () => {
        const listed = pipelineRun({ runId: 52, url: `https://github.com/acme/web/actions/runs/52`, createdAt: NOW - MINUTE });
        expect(failingWorkflowsOf(failing({ workflows }), [listed], repo, NOW)).toEqual([
            {
                name: `Nightly`,
                named: true,
                runId: 30,
                jobs: [`desktop-windows / smoke`],
                timedOut: [],
                since: undefined,
                url: `https://github.com/acme/web/actions/runs/30`,
                listed: false,
                blocker: { kind: `next` },
            },
            {
                name: `CI`,
                named: true,
                runId: 52,
                jobs: [`changes`],
                timedOut: [],
                since: undefined,
                url: listed.url,
                listed: true,
                blocker: { kind: `next` },
            },
        ]);
    });

    it(`carries the daemon's own start and the jobs that ran out of time`, () => {
        const timed = [{ name: `CI`, runId: 52, jobs: [`migrations`, `unit`], timedOut: [`migrations`], since: NOW - 5 * MINUTE }];
        expect(failingWorkflowsOf(failing({ workflows: timed }), [], repo, NOW)[0]).toMatchObject({ timedOut: [`migrations`], since: NOW - 5 * MINUTE });
    });

    it(`does not spell GitLab's one pipeline, and is nothing from a daemon that does not say`, () => {
        const gitlab = { host: `gitlab` as const, url: `https://gitlab.com/acme/api` };
        const [one] = failingWorkflowsOf(failing({ workflows: [{ name: `ci`, runId: 7, jobs: [`test`] }] }), [], gitlab);
        expect(one).toMatchObject({ named: false, url: `https://gitlab.com/acme/api/-/pipelines/7` });
        expect(failingWorkflowsOf(failing(), [], repo)).toEqual([]);
    });
});

describe(`failingSince`, () => {
    it(`is the longest-failing workflow's own start, else the failure's`, () => {
        const workflows = [
            { name: `Nightly`, runId: 30, jobs: [`smoke`], since: NOW - 3 * MINUTE },
            { name: `CI`, runId: 52, jobs: [`unit`], since: NOW - 9 * MINUTE },
        ];
        expect(failingSince(failing({ since: NOW - 999 * MINUTE, workflows }))).toBe(NOW - 9 * MINUTE);
        expect(failingSince(failing({ workflows: [{ name: `CI`, runId: 52, jobs: [`unit`] }] }))).toBe(NOW - 30 * MINUTE);
    });
});

describe(`workflowOfRun`, () => {
    it(`is the run's workflow, or the one pipeline a GitLab commit runs`, () => {
        expect(workflowOfRun({ workflow: `CI` })).toBe(`CI`);
        expect(workflowOfRun({})).toBe(`ci`);
        expect(workflowOfRun({ workflow: `` })).toBe(`ci`);
    });
});

describe(`blockerOf`, () => {
    const ci = { name: `CI`, runId: 43, jobs: [`unit`] };
    const branch = { repo: `web`, branch: `main` };

    it(`is measuring while a later run of the workflow goes, or its failing run is re-run`, () => {
        const going = pipelineRun({ runId: 50, workflow: `CI`, status: `queued` });
        expect(blockerOf(branch, ci, [going], NOW)).toEqual({ kind: `measuring`, run: going });
        const rerun = pipelineRun({ runId: 43, workflow: `CI`, status: `running` });
        expect(blockerOf(branch, ci, [rerun], NOW)).toEqual({ kind: `measuring`, run: rerun });
        // Another workflow going, or the same one on another branch, measures nothing of this one.
        const elsewhere = [pipelineRun({ runId: 51, workflow: `Scorecard`, status: `running` }), pipelineRun({ runId: 52, workflow: `CI`, branch: `feat/x`, status: `running` })];
        expect(blockerOf(branch, ci, elsewhere, NOW)).toEqual({ kind: `next` });
    });

    it(`is the cancelled run when the workflow's newest run after the failure was cancelled`, () => {
        const cancelled = pipelineRun({ runId: 60, workflow: `CI`, status: `canceled` });
        expect(blockerOf(branch, ci, [cancelled, pipelineRun({ runId: 43, workflow: `CI` })], NOW)).toEqual({ kind: `cancelled`, run: cancelled });
        const older = pipelineRun({ runId: 41, workflow: `CI`, status: `canceled` });
        expect(blockerOf(branch, ci, [older], NOW)).toEqual({ kind: `next` });
    });

    it(`is scheduled for a workflow a push never runs, by the daemon's word or the failing run's`, () => {
        expect(blockerOf(branch, { ...ci, trigger: `schedule` }, [], NOW)).toEqual({ kind: `scheduled` });
        expect(blockerOf(branch, ci, [pipelineRun({ runId: 43, workflow: `CI`, trigger: `schedule`, createdAt: NOW - MINUTE })], NOW)).toEqual({
            kind: `scheduled`,
        });
        expect(blockerOf(branch, { ...ci, trigger: `push` }, [], NOW)).toEqual({ kind: `next` });
    });

    // Nightly 43471063277: a hand-started Nightly's fix was pushed, and the banner kept saying "commit and push it".
    it(`is by hand for a hand-started workflow no push runs, by the daemon's word or the failing run's`, () => {
        expect(blockerOf(branch, { ...ci, trigger: `workflow_dispatch` }, [], NOW)).toEqual({ kind: `byHand` });
        expect(blockerOf(branch, ci, [pipelineRun({ runId: 43, workflow: `CI`, trigger: `workflow_dispatch`, createdAt: NOW - MINUTE })], NOW)).toEqual({
            kind: `byHand`,
        });
    });

    it(`waits for the next push when the board shows a push running the hand-started workflow on its branch`, () => {
        const pushed = pipelineRun({ runId: 40, workflow: `CI`, trigger: `push`, status: `success` });
        expect(blockerOf(branch, { ...ci, trigger: `workflow_dispatch` }, [pushed], NOW)).toEqual({ kind: `next` });
        // A push of another workflow, or of this one on another branch, says nothing about whether a push runs it here.
        const elsewhere = [
            pipelineRun({ runId: 41, workflow: `Scorecard`, trigger: `push`, status: `success` }),
            pipelineRun({ runId: 42, workflow: `CI`, branch: `feat/x`, trigger: `push`, status: `success` }),
        ];
        expect(blockerOf(branch, { ...ci, trigger: `workflow_dispatch` }, elsewhere, NOW)).toEqual({ kind: `byHand` });
    });

    it(`is quiet once it has not failed for days and nothing ran it, with the day the daemon lets it go`, () => {
        const failedAt = NOW - QUIET_AFTER_MS - MINUTE;
        expect(blockerOf(branch, { ...ci, failedAt }, [], NOW)).toEqual({ kind: `quiet`, failedAt, dropsAt: failedAt + MAIN_FAILURE_STALE_MS, pushless: false });
        expect(blockerOf(branch, { ...ci, failedAt, trigger: `schedule` }, [], NOW)).toMatchObject({ kind: `quiet`, pushless: true });
        expect(blockerOf(branch, { ...ci, failedAt, trigger: `workflow_dispatch` }, [], NOW)).toMatchObject({ kind: `quiet`, pushless: true });
        expect(blockerOf(branch, { ...ci, failedAt: NOW - QUIET_AFTER_MS + MINUTE }, [], NOW)).toEqual({ kind: `next` });
    });

    it(`counts only measuring and the next push as something on its way`, () => {
        const run = pipelineRun({ runId: 50 });
        expect(
            [
                { kind: `measuring` as const, run },
                { kind: `next` as const },
                { kind: `cancelled` as const, run },
                { kind: `scheduled` as const },
                { kind: `byHand` as const },
                { kind: `quiet` as const, failedAt: 0, dropsAt: 1, pushless: false },
            ].map(stalls),
        ).toEqual([false, false, true, true, true, true]);
    });
});

describe(`storyOf`, () => {
    const fixing = (status: AgentSummary["status"], over: Partial<AgentSummary> = {}) => {
        const fixer = agentCard(`ci-fix-web-41`, { status, updatedAt: NOW - 5 * MINUTE, ...over });
        return { state: `fixing` as const, fixer, stance: fixStance(fixer), failure: failing() };
    };

    it(`follows the agent's live stance while it has the failure, not the fact that one was sent`, () => {
        expect(storyOf(fixing(`running`), [])).toBe(`working`);
        expect(storyOf(fixing(`ready`), [])).toBe(`ready`);
        expect(storyOf(fixing(`landed`), [])).toBe(`landed`);
        expect(storyOf(fixing(`awaiting`, { attention: { ...agentCard(`x`).attention, question: true } }), [])).toBe(`needsYou`);
        expect(storyOf(fixing(`stopped`), [])).toBe(`ended`);
        expect(storyOf({ state: `fixing`, fixer: undefined, stance: undefined, failure: failing() }, [])).toBe(`working`);
    });

    // A docs line landed beside a dashboard step is not the fix: the step is what the reader is owed.
    it(`tells a step outside the repository ahead of what the agent holds`, () => {
        expect(storyOf({ ...fixing(`landed`), ownerStep: `Fill the field in the store's dashboard.` }, [])).toBe(`outside`);
    });

    it(`carries the fixer's step only while its turn is its last word`, () => {
        const fixer = agentCard(`ci-fix-web-41`, { status: `landed` });
        const steps = [{ conversationId: fixer.id, step: `Fill the field.`, at: 1 }];
        const failure = failing({ fixer: fixer.id, decision: decided(`fix-up`, { conversationId: fixer.id }) });
        expect(mainFailuresOf([failure], [fixer], [], steps)[0]?.ownerStep).toBe(`Fill the field.`);
        expect(mainFailuresOf([failure], [{ ...fixer, status: `running` }], [], steps)[0]?.ownerStep).toBeUndefined();
    });

    it(`calls a landed fix measured once a run starts after it landed, and only then`, () => {
        const before = pipelineRun({ runId: 51, status: `running`, createdAt: NOW - 6 * MINUTE });
        const after = pipelineRun({ runId: 52, status: `running`, createdAt: NOW - 4 * MINUTE });
        expect(storyOf(fixing(`landed`), [before])).toBe(`landed`);
        expect(storyOf(fixing(`landed`), [after, before])).toBe(`proving`);
    });

    // From a daemon that does not tell workflows apart, a pass after the land is the only word that the push happened.
    it(`calls a landed fix stalled once any run on the branch passed after it, where workflows are not told apart`, () => {
        const passedAfter = pipelineRun({ runId: 53, status: `success`, createdAt: NOW - 4 * MINUTE });
        const passedBefore = pipelineRun({ runId: 50, status: `success`, createdAt: NOW - 6 * MINUTE });
        const otherBranch = pipelineRun({ runId: 54, status: `success`, branch: `feat/x`, createdAt: NOW - 3 * MINUTE });
        expect(storyOf(fixing(`landed`), [], [passedBefore, otherBranch])).toBe(`landed`);
        expect(storyOf(fixing(`landed`), [], [passedAfter, passedBefore])).toBe(`stalled`);
        const measuring = pipelineRun({ runId: 55, status: `running`, createdAt: NOW - 2 * MINUTE });
        expect(storyOf(fixing(`landed`), [measuring], [measuring, passedAfter])).toBe(`proving`);
    });

    // The case behind "newer runs on main pass" over a CI that had been cancelled: Scorecard and CodeQL passed after the
    // push, CI's own run was cancelled, and the nightly only runs on its schedule. Nothing on its way measures either.
    it(`calls a pushed fix stalled when nothing on its way will run a failing workflow again`, () => {
        const workflows = [
            { name: `CI`, runId: 43, jobs: [`verify-core / verify`] },
            { name: `Nightly`, runId: 30, jobs: [`desktop-windows / smoke`], trigger: `schedule` },
        ];
        const view = { ...fixing(`landed`), failure: failing({ workflows }) };
        const scorecard = pipelineRun({ runId: 61, workflow: `Scorecard`, status: `success`, createdAt: NOW - 3 * MINUTE });
        const cancelled = pipelineRun({ runId: 60, workflow: `CI`, status: `canceled`, createdAt: NOW - 3 * MINUTE });
        expect(storyOf(view, [cancelled], [scorecard, cancelled], NOW)).toBe(`stalled`);
        // Scorecard passing alone says nothing of CI: its newest run is still the failing one, and a push measures it.
        expect(storyOf(view, [], [scorecard], NOW)).toBe(`landed`);
        // Nothing ran on the branch since the land: it is not pushed yet, whatever else blocks it.
        expect(storyOf(view, [], [pipelineRun({ runId: 60, workflow: `CI`, status: `canceled`, createdAt: NOW - 9 * MINUTE })], NOW)).toBe(`landed`);
    });

    it(`is the failure's own state once nobody is working on it`, () => {
        const states = [`waits`, `reported`, `unassigned`] as const;
        expect(states.map((state) => storyOf({ state, fixer: undefined, stance: undefined, failure: failing() }, []))).toEqual([
            `waits`,
            `reported`,
            `unassigned`,
        ]);
    });
});
