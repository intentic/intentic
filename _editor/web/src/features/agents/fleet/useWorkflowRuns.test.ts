import type { WorkflowRun } from "@intentic/sandbox-contract";
import { describe, expect, it, vi } from "vitest";
import type { FleetAgent } from "./useAgents-fleet";
import { insideRun, laneOfRun, runIdsInLedger, runMatches, runsInLane } from "./useWorkflowRuns";

// Importing these functions pulls in the sandbox client and fleet store, which read `window.env` at import time;
// mocked here even though this file never touches them.
vi.mock("../../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../../../app/analytics", () => ({ track: vi.fn() }));
vi.mock("../../sandbox/client/sandboxClient", () => ({ sandboxJson: vi.fn(), sandboxRequest: vi.fn() }));
vi.mock("../../sandbox/client/useSandboxQuery", () => ({ useSandboxQuery: vi.fn() }));

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
