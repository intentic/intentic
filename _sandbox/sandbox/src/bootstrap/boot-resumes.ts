import { streamAgent } from "../agent/routes/agent.routes.js";
import { createTurnResumeScheduler, resumeInterruptedTurns } from "../agent/run/turn/turn-resume.js";
import { restoreWatchers } from "../agent/verification/watchers.js";
import { resumeWorkflowExecution } from "../workflows/workflow-runner.js";
import type { BootPhase } from "./boot-phase.js";

// What was still in flight when the last daemon died, restarted once each. The journals on disk are the record of it,
// so whatever survived to here is what the death interrupted; every restart is gated and attempt-bounded, and a
// failure leaves the item standing on the record as interrupted rather than taking this boot down.
export const startBootResumes = ({ logger, role, services, shutdown }: BootPhase): void => {
    // Re-runs a turn killed by something the daemon can undo on its own (a rotated credential). The three walls the
    // reader answers for — a spent allowance, a provider outage, a turn that stopped short — re-run only on that
    // conversation's own policy, and every one of them starts at `wait`.
    const turnResume = createTurnResumeScheduler(services, streamAgent);
    shutdown.push(() => turnResume.stop());
    if (role.roots) {
        turnResume.start();
    }

    // The turn journal holds every turn in flight, so whatever survived to here is what killed the daemon. Re-run once
    // each. Detached: an interrupted turn is a whole turn.
    void resumeInterruptedTurns(services, streamAgent).catch((error: unknown) =>
        logger.error({ err: error }, "interrupted turns could not be resumed, they stand on the record as interrupted"),
    );

    // Same restart story for condition watches, sharper here since a watch's whole life is between turns. Each is
    // re-checked once, since it may have resolved during the rebuild, and re-armed with its remaining time.
    void restoreWatchers().catch((error: unknown) => logger.error({ err: error }, "armed condition watches could not be restored"));

    // Same restart story for loops and workflow runs, coordinated since every workflow step is itself a loop: the
    // coordinator reserves workflow-owned conversations before generic loop recovery sees the rest.
    void resumeWorkflowExecution(services, streamAgent).catch((error: unknown) =>
        logger.error({ err: error }, "loops and workflow runs could not be resumed"),
    );
};
