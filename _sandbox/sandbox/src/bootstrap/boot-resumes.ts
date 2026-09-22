import { streamAgent } from "../agent/routes/agent.routes.js";
import { createTurnResumeScheduler, resumeInterruptedTurns } from "../agent/run/turn/turn-resume.js";
import { restoreBackgroundJobs } from "../agent/tools/background-jobs.js";
import { restoreWatchers } from "../agent/verification/watchers.js";
import { resumeWorkflowExecution } from "../workflows/workflow-runner.js";
import type { BootPhase } from "./boot-phase.js";

// Every restart is gated and attempt-bounded; a failure leaves the item on the record as interrupted.
export const startBootResumes = ({ logger, role, services, shutdown }: BootPhase): void => {
    // A spent allowance, a provider outage or a turn that stopped short re-run only on the conversation's own policy.
    const turnResume = createTurnResumeScheduler(services, streamAgent);
    shutdown.push(() => turnResume.stop());
    if (role.roots) {
        turnResume.start();
    }

    // Detached: an interrupted turn is a whole turn.
    void resumeInterruptedTurns(services, streamAgent).catch((error: unknown) =>
        logger.error({ err: error }, "interrupted turns could not be resumed, they stand on the record as interrupted"),
    );

    // Each watch is re-checked once, since it may have resolved during the rebuild.
    void restoreWatchers().catch((error: unknown) => logger.error({ err: error }, "armed condition watches could not be restored"));

    // Background jobs kept running through the rebuild in panes of their own; taking them back is what keeps the
    // reaper off their terminals. They come back already adopted, since the watch above is restoring their wakes.
    try {
        const jobs = restoreBackgroundJobs();
        if (jobs > 0) {
            logger.info({ jobs }, "background jobs still running were taken back, their terminals are spared");
        }
    } catch (error) {
        logger.warn({ err: error }, "background jobs could not be taken back, a still-running one may lose its terminal");
    }

    // The coordinator reserves workflow-owned conversations before generic loop recovery sees the rest.
    void resumeWorkflowExecution(services, streamAgent).catch((error: unknown) =>
        logger.error({ err: error }, "loops and workflow runs could not be resumed"),
    );
};
