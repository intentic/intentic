import type { WorkflowRun } from "@intentic/sandbox-contract";
import { mocked, waitFor } from "@intentic/testing/bun";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createApp, effectScope, ref } from "vue";
import { rpcKey } from "../../../lib/queryKeys";
import type { ProcedureOutput } from "../../sandbox/client/sandboxRpc";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import type { FleetAgent } from "./useAgents-fleet";
import { insideRun, laneOfRun, runIdsInLedger, runMatches, runsInLane, useWorkflowRuns } from "./useWorkflowRuns";

// Importing these functions pulls in the fleet store, which reads `window.env` at import time; mocked here even
// though this file never touches it.
jest.mock("../../../router", () => ({ router: { push: jest.fn() } }));
jest.mock("../../../app/analytics", () => ({ track: jest.fn() }));
// The two filing verbs this file presses; any other call names itself.
const archiveRun = jest.fn();
const unarchiveRun = jest.fn();
jest.mock("../../sandbox/client/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ workflows: { archiveRun, unarchiveRun } }) }));
jest.mock("../../sandbox/client/useSandboxQuery", () => ({ useSandboxQuery: jest.fn() }));

// The grouping rule alone: the pure half of a run row shared by the board's lanes, the board's archive, and the
// floating rail.

const run = (runId: string, over: Partial<WorkflowRun> = {}): WorkflowRun =>
    ({
        runId,
        workflow: { id: `wf`, name: `Two models, one task`, steps: [], maxParallel: 2 },
        repos: [{ repo: `root`, base: `1111111111111111111111111111111111111111` }],
        state: `done`,
        startedAt: 1,
        resumed: 0,
        steps: [],
        ...over,
    }) as WorkflowRun;

const agent = (id: string, runId?: string): FleetAgent =>
    ({
        id,
        title: `Greeting message`,
        ...(runId === undefined ? {} : { workflow: { runId, name: `Two models, one task`, step: `Claude's attempt`, index: 1, total: 3 } }),
    }) as FleetAgent;

// Asks the ledger, not the surface: a run whose row is off-screen no longer releases its steps as loose cards.
describe("insideRun", () => {
    const ledger = runIdsInLedger([run(`r1`), run(`r2`, { archivedAt: 9_000 })]);

    it("hides a step of a run the ledger holds, archived or not", () => {
        expect(insideRun(agent(`a1`, `r1`), ledger)).toBe(true);
        expect(insideRun(agent(`a2`, `r2`), ledger)).toBe(true);
    });

    it("leaves an ordinary conversation alone", () => {
        expect(insideRun(agent(`a3`), ledger)).toBe(false);
    });

    // Safety valve: a run rolled off the ledger has no row anywhere, so its steps must be shown rather than hidden.
    it("releases a step whose run has rolled off the ledger", () => {
        expect(insideRun(agent(`a4`, `gone`), ledger)).toBe(false);
    });
});

// What a query finds now that steps can't answer for themselves.
describe("runMatches", () => {
    const always = (): boolean => true;
    const never = (): boolean => false;

    it("matches the run's own name and the request it was pointed at", () => {
        expect(runMatches(run(`r1`), `two models`, [], never)).toBe(true);
        expect(runMatches(run(`r1`, { request: `Write the greeting` }), `greeting`, [], never)).toBe(true);
    });

    // Asked through the board's own predicate, so a hit in a step's transcript still surfaces as its run.
    it("matches through a step, and only that run's steps", () => {
        expect(runMatches(run(`r1`), `nothing`, [agent(`a1`, `r1`)], always)).toBe(true);
        expect(runMatches(run(`r1`), `nothing`, [agent(`a2`, `other`)], always)).toBe(false);
    });

    it("says no when neither the run nor its steps have it", () => {
        expect(runMatches(run(`r1`), `nothing`, [agent(`a1`, `r1`)], never)).toBe(false);
    });
});

// Same three lanes as an agent; an ended run nobody must act on is Finished.
describe("laneOfRun", () => {
    it("files the two outcomes somebody has to do something about under attention", () => {
        expect(laneOfRun(run(`r1`, { state: `overspent` }))).toBe(`attention`);
        expect(laneOfRun(run(`r1`, { state: `error` }))).toBe(`attention`);
    });

    // A step holding a question puts the run, not the step, in attention.
    it("inherits a step's claim on the user", () => {
        expect(laneOfRun(run(`r1`, { state: `running` }), true)).toBe(`attention`);
        expect(laneOfRun(run(`r1`, { state: `running` }))).toBe(`active`);
    });
});

// The caller owns the Finished cap: a capped run hides its steps too, so the caller must lift the window here as
// well.
describe("runsInLane", () => {
    const finished = [run(`r1`), run(`r2`), run(`r3`)];

    it("caps finished at the window and leaves the self-emptying lanes whole", () => {
        expect(runsInLane(finished, `finished`, 2, new Set()).map((entry) => entry.runId)).toEqual([`r1`, `r2`]);
        expect(runsInLane([run(`r1`, { state: `running` }), run(`r2`, { state: `running` })], `active`, 1, new Set())).toHaveLength(2);
    });

    it("hands back everything when the caller lifts the window", () => {
        expect(runsInLane(finished, `finished`, Number.POSITIVE_INFINITY, new Set())).toHaveLength(3);
    });
});

// Filing a run away is lossless and undone from the archive itself, so the row moves on the press and the daemon's
// answer only ever confirms it. A refusal puts back that one run's filing, and nothing else the ledger holds.
describe("filing a run on the press", () => {
    // The composable under vue-query's injection, with no component: a mutation needs the client and a scope, nothing
    // that draws.
    const standUp = (): { client: QueryClient; runs: ReturnType<typeof useWorkflowRuns> } => {
        const client = new QueryClient();
        const app = createApp({});
        app.use(VueQueryPlugin, { queryClient: client });
        mocked(useSandboxQuery).mockReturnValue({ query: { data: ref(undefined) } } as never);
        const runs = effectScope().run(() => app.runWithContext(() => useWorkflowRuns()))!;
        return { client, runs };
    };
    // The ledger as the query holds it: the daemon's whole answer, filed under its route name.
    const filedAt = (client: QueryClient, runId: string): number | undefined =>
        client.getQueryData<ProcedureOutput<`workflows.runs`>>(rpcKey(`workflows.runs`))?.runs.find((entry) => entry.runId === runId)?.archivedAt;
    // The daemon's answer to the one press out, held open so the frame before it can be read.
    const heldRefusal = (): ((error: Error) => void) => {
        let refuse: (error: Error) => void = () => undefined;
        for (const verb of [archiveRun, unarchiveRun]) {
            verb.mockImplementation(() => new Promise((_answer, fail) => (refuse = fail)));
        }
        return (error) => refuse(error);
    };

    it("files the run away on the press, and back where it stood when the daemon refuses", async () => {
        const { client, runs } = standUp();
        client.setQueryData(rpcKey(`workflows.runs`), { runs: [run(`r1`), run(`r2`)] });
        const refuse = heldRefusal();

        const press = runs.archive.mutateAsync(`r1`);

        await waitFor(() => expect(filedAt(client, `r1`)).toEqual(expect.any(Number)));
        expect(filedAt(client, `r2`)).toBeUndefined();
        expect(archiveRun).toHaveBeenCalledWith({ runId: `r1` });
        refuse(new Error(`the run is still going`));
        await expect(press).rejects.toThrow(`the run is still going`);
        expect(filedAt(client, `r1`)).toBeUndefined();
    });

    it("brings an archived run back on the press, and returns it to the archive, filing date and all, when refused", async () => {
        const { client, runs } = standUp();
        client.setQueryData(rpcKey(`workflows.runs`), { runs: [run(`r1`, { archivedAt: 9_000 })] });
        const refuse = heldRefusal();

        const press = runs.unarchive.mutateAsync(`r1`);

        await waitFor(() => expect(filedAt(client, `r1`)).toBeUndefined());
        expect(unarchiveRun).toHaveBeenCalledWith({ runId: `r1` });
        refuse(new Error(`its sessions are gone`));
        await expect(press).rejects.toThrow(`its sessions are gone`);
        expect(filedAt(client, `r1`)).toBe(9_000);
    });
});
