import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { createLandFailureObserver } from "./landFailureTelemetry";

const agent = {
    id: `a1`, status: `error`, attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    landFailure: { reason: `the forker exited`, at: 1 }, diff: { files: 12_621, insertions: 0, deletions: 0 },
} satisfies Parameters<ReturnType<typeof createLandFailureObserver>>[0];

test(`a failure transition emits once per agent and sandbox, with categories and counts only`, () => {
    const events: unknown[] = [];
    const observe = createLandFailureObserver((event, properties) => events.push({ event, properties }));
    observe(agent, `box`);
    observe({ ...agent }, `box`);
    observe({ ...agent, landFailure: { ...agent.landFailure, at: 2 } }, `box`);
    observe(agent, `another-box`);
    expect(events).toEqual(Array.from({ length: 3 }, () => ({ event: `land_failed`, properties: { code: `forker_exited`, delta_files: 12_621 } })));
});

test(`a cleared conflict can fail again, carrying its refused count when the review is known`, () => {
    const events: unknown[] = [];
    const observe = createLandFailureObserver((event, properties) => events.push({ event, properties }));
    const { landFailure: _failure, ...rest } = agent;
    const conflict = { ...rest, status: `conflict`, attention: { ...rest.attention, conflict: true }, conflictCauses: [`workspace`] } satisfies Partial<AgentSummary>;
    const report = [{ repo: `root`, paths: [{ path: `private-file.txt`, reason: `workspace` as const }], clean: 0 }];
    observe(conflict, `box`, report);
    observe(conflict, `box`, report);
    observe({ ...rest, status: `ready` }, `box`);
    observe(conflict, `box`, report);
    expect(events).toEqual(Array.from({ length: 2 }, () => ({ event: `land_failed`, properties: { code: `workspace`, refused_count: 1, delta_files: 12_621 } })));
});
