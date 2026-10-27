import type { GroupSamples } from "./context.ts";

// A gated copy of the design is created, its gate token rotated and the copy removed again; the run is started on the
// design itself, and the seeded run (`a3f19c22`) is the one stopped, archived and brought back.
export const workflowsSamples: GroupSamples<`workflows`> = ({ design }) => ({
    list: undefined,
    runs: undefined,
    save: {
        workflow: { ...design, id: `smoke-gated`, gate: { step: `review-security`, field: `findings`, pass: [`none`] } },
        create: true,
    },
    rotateGateToken: { id: `smoke-gated` },
    remove: { id: `smoke-gated` },
    run: { id: design.id, request: `Add Apple Pay to the checkout` },
    stopRun: { runId: `a3f19c22` },
    archiveRun: { runId: `a3f19c22` },
    unarchiveRun: { runId: `a3f19c22` },
});
