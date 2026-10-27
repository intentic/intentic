import type { Samples } from "../smoke-daemon.ts";

// What every group's samples may read: the fixture modules the smoke bundled, the clock, and the records picked out of
// them once (a pipeline run, an automation, a workflow design, a paired host, a prepared approval), so a renamed id in the
// fixture moves the inputs with it.
export interface SampleFixtures {
    readonly fleet: typeof import("../../src/fixture/fleet.ts");
    readonly automations: typeof import("../../src/fixture/automations.ts");
    readonly ci: typeof import("../../src/fixture/ci.ts");
    readonly workflows: typeof import("../../src/fixture/workflows.ts");
    readonly loops: typeof import("../../src/fixture/loops.ts");
    readonly devices: typeof import("../../src/fixture/devices.ts");
    readonly approvals: typeof import("../../src/fixture/approvals.ts");
}

type Automations = SampleFixtures[`automations`];

export interface SampleContext extends SampleFixtures {
    readonly now: number;
    readonly pipeline: { readonly repo: string; readonly runId: number };
    readonly automation: ReturnType<Automations[`automationsList`]>[number];
    // The held wake an approval is sent for: the fixture's first, or a made-up id when it holds none.
    readonly held: { readonly id: string };
    readonly design: ReturnType<SampleFixtures[`workflows`][`demoWorkflows`]>[number];
    readonly loop: ReturnType<SampleFixtures[`loops`][`demoLoops`]>[number];
    readonly host: string;
    readonly prepared: ReturnType<SampleFixtures[`approvals`][`demoApprovals`]>[number];
}

const required = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) {
        throw new Error(`demo smoke: the fixture holds no ${what} to send`);
    }
    return value;
};

/** The records every group's samples are built from, picked out of the bundled fixtures. */
export const sampleContext = (fixtures: SampleFixtures, now: number): SampleContext => {
    const run = required(fixtures.ci.ciRunsResponse(now).runs[0], `pipeline run`);
    return {
        ...fixtures,
        now,
        pipeline: { repo: run.repo, runId: run.runId },
        automation: required(fixtures.automations.automationsList(now)[0], `automation`),
        held: fixtures.automations.automationApprovals(now)[0] ?? { id: `smoke-held` },
        design: required(fixtures.workflows.demoWorkflows([])[0], `workflow`),
        loop: required(fixtures.loops.demoLoops()[0], `loop design`),
        host: required(fixtures.devices.demoDevices(now)[0]?.hostId, `paired device`),
        prepared: required(fixtures.approvals.demoApprovals()[0], `prepared approval`),
    };
};

/** One group's samples, built from the context (a group that needs none of it takes no argument). */
export type GroupSamples<G extends keyof Samples> = (context: SampleContext) => Samples[G];
