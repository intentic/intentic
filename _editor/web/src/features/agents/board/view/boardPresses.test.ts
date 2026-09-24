import "@intentic/testing/dom";
import { unstubbed } from "@intentic/testing";
import type { WorkflowRun } from "@intentic/sandbox-contract";
import { type EffectScope, effectScope, nextTick, ref, shallowRef } from "vue";
import type { RouteLocationRaw, Router } from "vue-router";
import { useBoardPresses } from "./boardPresses";

// Pins the presses that land on no agent card: a run's stop stays marked until the ledger says it stopped, a refused
// stop or filing says why on the notice strip rather than throwing at the row, a run's diagram is the workflows page,
// a refused wake re-reads the board, and a synthesis that cannot start says why on the notice strip.

const run = (runId: string, state: WorkflowRun[`state`]): WorkflowRun =>
    ({ runId, workflow: { id: `wf`, name: `Review`, steps: [], maxParallel: 1 }, state, startedAt: 1, steps: [] }) as unknown as WorkflowRun;

const running: EffectScope[] = [];
afterEach(() => {
    for (const effects of running.splice(0)) {
        effects.stop();
    }
});

const pressesOf = () => {
    const runs = shallowRef<readonly WorkflowRun[]>([run(`r1`, `running`)]);
    const write = () => ({ mutateAsync: jest.fn(async (_runId: string): Promise<unknown> => undefined) });
    const workflows = { runs, stop: write(), archive: write(), unarchive: write() };
    const push = jest.fn(async (_to: RouteLocationRaw) => undefined);
    const agents = {
        releaseHeld: jest.fn(async (_id: string, _verb: `approve` | `reject`) => undefined),
        refresh: jest.fn(async () => undefined),
        notice: ref<string>(),
    };
    const effects = effectScope();
    running.push(effects);
    const presses = effects.run(() => useBoardPresses({ workflows, agents, router: unstubbed<Router>(`router`, { push }) }))!;
    return { runs, workflows, agents, push, presses };
};

describe(`a workflow run's row`, () => {
    it(`stays stopping after its request returns, until the ledger says the run stopped`, async () => {
        const { runs, workflows, presses } = pressesOf();
        await presses.stopRun(run(`r1`, `running`));
        expect(workflows.stop.mutateAsync.mock.calls).toEqual([[`r1`]]);
        expect([...presses.stoppingRuns.value]).toEqual([`r1`]);

        runs.value = [run(`r1`, `stopped`)];
        await nextTick();
        expect([...presses.stoppingRuns.value]).toEqual([]);
    });

    it(`lets a stop the daemon refused go at once, rather than leave the row stuck, and says why on the strip`, async () => {
        const { workflows, agents, presses } = pressesOf();
        workflows.stop.mutateAsync.mockImplementation(async () => {
            throw new Error(`The ledger is locked by another write.`);
        });
        await presses.stopRun(run(`r1`, `running`));
        expect([...presses.stoppingRuns.value]).toEqual([]);
        expect(agents.notice.value).toBe(`The ledger is locked by another write.`);
    });

    it(`files a run away and back without ever throwing at the row, and a refusal says why on the strip`, async () => {
        const { workflows, agents, presses } = pressesOf();
        await presses.archiveRun(run(`r1`, `done`));
        expect(agents.notice.value).toBeUndefined();

        workflows.archive.mutateAsync.mockImplementation(async () => {
            throw new Error(`refused`);
        });
        await presses.archiveRun(run(`r1`, `done`));
        expect(agents.notice.value).toBe(`refused`);

        workflows.unarchive.mutateAsync.mockImplementation(async () => {
            throw new Error(`gone`);
        });
        await presses.restoreRun(run(`r2`, `done`));
        expect(agents.notice.value).toBe(`gone`);
        expect([workflows.archive.mutateAsync.mock.calls, workflows.unarchive.mutateAsync.mock.calls]).toEqual([[[`r1`], [`r1`]], [[`r2`]]]);
    });

    it(`opens its diagram on the workflows page`, () => {
        const { push, presses } = pressesOf();
        presses.openRunGraph(run(`r1`, `running`));
        expect(push.mock.calls).toEqual([[{ name: `extension`, params: { ext: `workflows` }, query: { run: `r1` } }]]);
    });
});

describe(`a held wake's row`, () => {
    it(`releases with the verb pressed, and re-reads the board when the daemon had already moved on`, async () => {
        const { agents, presses } = pressesOf();
        await presses.releaseWake(`w1`, `approve`);
        expect(agents.refresh).not.toHaveBeenCalled();

        agents.releaseHeld.mockImplementation(async () => {
            throw new Error(`already released`);
        });
        await presses.releaseWake(`w2`, `reject`);
        expect(agents.releaseHeld.mock.calls).toEqual([
            [`w1`, `approve`],
            [`w2`, `reject`],
        ]);
        expect(agents.refresh).toHaveBeenCalledTimes(1);
    });
});

describe(`Synthesize`, () => {
    it(`says on the notice strip why it could not start`, async () => {
        const { agents, presses } = pressesOf();
        await presses.synthesize();
        expect(agents.notice.value).toBe(`Open at least two conversations side by side to synthesize them.`);
    });
});
