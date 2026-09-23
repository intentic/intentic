import { createTurnResumeScheduler, resumeInterruptedTurns } from "../agent/run/turn/turn-resume.js";
import { adoptBackgroundJobs } from "../agent/tools/background-adoption.js";
import { restoreBackgroundJobs } from "../agent/tools/background-jobs.js";
import { restoreWatchers } from "../agent/verification/watchers.js";
import { resumeInterruptedFires } from "../automations/fire-resume.js";
import { resumeWorkflowExecution } from "../workflows/workflow-runner.js";
import type { BootPhase } from "./boot-phase.js";

// Every restart is gated and attempt-bounded; a failure leaves the item on the record as interrupted.
export const startBootResumes = ({ logger, role, services, shutdown }: BootPhase): void => {
    // A spent allowance, a provider outage or a turn that stopped short re-run only on the conversation's own policy.
    const turnResume = createTurnResumeScheduler(services);
    shutdown.push(() => turnResume.stop());
    if (role.roots) {
        turnResume.start();
    }

    // Detached: an interrupted turn is a whole turn, and an interrupted automation fire a whole fire.
    void resumeInterruptedTurns(services).catch((error: unknown) =>
        logger.error({ err: error }, "interrupted turns could not be resumed, they stand on the record as interrupted"),
    );
    void resumeInterruptedFires(services).catch((error: unknown) =>
        logger.error({ err: error }, "interrupted automation fires could not be re-fired, they stand on the record as interrupted"),
    );

    // Each watch is re-checked once, since it may have resolved during the rebuild.
    void restoreWatchers().catch((error: unknown) => logger.error({ err: error }, "armed condition watches could not be restored"));

    // A job whose turn died before adopting it is adopted now, or its ending would reach nobody.
    try {
        const jobs = restoreBackgroundJobs(services.conversations);
        if (jobs.length > 0) {
            logger.info({ jobs: jobs.length }, "background jobs still running were taken back, their terminals are spared");
        }
        for (const conversationId of new Set(jobs.map((job) => job.conversationId))) {
            void adoptBackgroundJobs(services.conversations, conversationId, logger);
        }
    } catch (error) {
        logger.warn({ err: error }, "background jobs could not be taken back, a still-running one may lose its terminal");
    }

    // The coordinator reserves workflow-owned conversations before generic loop recovery sees the rest.
    void resumeWorkflowExecution(services).catch((error: unknown) => logger.error({ err: error }, "loops and workflow runs could not be resumed"));
};
