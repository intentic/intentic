import type { WorkflowRun } from "@intentic/sandbox-contract";
import { describe, expect, it, vi } from "vitest";
import type { FleetAgent } from "./useAgents";
import { insideRun, laneOfRun, runIdsInLedger, runMatches, runsInLane } from "./useWorkflowRuns";

// The same module-eval cuts the sibling suites make: these are pure functions, but importing them pulls the
// composable's sandbox client and the fleet store behind it, and those read environment.ts's `window.env` at
// import time. Nothing here touches either.
vi.mock("../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../analytics", () => ({ track: vi.fn() }));
vi.mock("../sandbox/sandboxClient", () => ({ sandboxJson: vi.fn(), sandboxRequest: vi.fn() }));
vi.mock("../sandbox/useSandboxQuery", () => ({ useSandboxQuery: vi.fn() }));

/* The grouping rule, on its own. These are the pure half of the run row: the half three surfaces share (the
 * board's lanes, the board's archive, the popped-out rail) and the half that was getting the answer wrong,
 * so it is tested here rather than through any one of them.
 */

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

/* THE RULE ITSELF. It asks the LEDGER, not the surface, and the difference is every bug this replaced: a run
 * whose row a filter or a lane window had taken off screen used to release its conversations as loose cards,
 * so one job reported itself as five agents the moment you typed into the search box.
 */
describe("insideRun", () => {
    const ledger = runIdsInLedger([run(`r1`), run(`r2`, { archivedAt: 9_000 })]);

    it("hides a step of a run the ledger holds, archived or not", () => {
        expect(insideRun(agent(`a1`, `r1`), ledger)).toBe(true);
        expect(insideRun(agent(`a2`, `r2`), ledger)).toBe(true);
    });

    it("leaves an ordinary conversation alone", () => {
        expect(insideRun(agent(`a3`), ledger)).toBe(false);
    });

    /* The safety valve, and the reason this is not simply `agent.workflow !== undefined`: a run that has rolled
     * off the ledger has no row anywhere, so nothing would be standing for its chats. Hiding work nothing else
     * is showing is the one outcome worse than showing it twice. */
    it("releases a step whose run has rolled off the ledger", () => {
        expect(insideRun(agent(`a4`, `gone`), ledger)).toBe(false);
    });
});

// What a query finds now that the steps cannot answer for themselves.
describe("runMatches", () => {
    const always = (): boolean => true;
    const never = (): boolean => false;

    it("matches the run's own name and the request it was pointed at", () => {
        expect(runMatches(run(`r1`), `two models`, [], never)).toBe(true);
        expect(runMatches(run(`r1`, { request: `Write the greeting` }), `greeting`, [], never)).toBe(true);
    });

    // The step half, asked through the board's own predicate, so a hit the daemon found in a step's transcript
    // still surfaces, as the run it belongs to.
    it("matches through a step, and only that run's steps", () => {
        expect(runMatches(run(`r1`), `nothing`, [agent(`a1`, `r1`)], always)).toBe(true);
        expect(runMatches(run(`r1`), `nothing`, [agent(`a2`, `other`)], always)).toBe(false);
    });

    it("says no when neither the run nor its steps have it", () => {
        expect(runMatches(run(`r1`), `nothing`, [agent(`a1`, `r1`)], never)).toBe(false);
    });
});

// A run wears the same three lanes an agent does, and an ended one that nobody has to act on is Finished.
describe("laneOfRun", () => {
    it("files the two outcomes somebody has to do something about under attention", () => {
        expect(laneOfRun(run(`r1`, { state: `overspent` }))).toBe(`attention`);
        expect(laneOfRun(run(`r1`, { state: `error` }))).toBe(`attention`);
    });

    // A step holding a question puts the RUN in attention, because the step has no card to hold it on.
    it("inherits a step's claim on the user", () => {
        expect(laneOfRun(run(`r1`, { state: `running` }), true)).toBe(`attention`);
        expect(laneOfRun(run(`r1`, { state: `running` }))).toBe(`active`);
    });
});

/* The Finished cap. It is the CALLER's now: a capped run takes its steps into hiding with it, so the surface
 * that lifts the window for its agents has to lift it here in the same breath.
 */
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
