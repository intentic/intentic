import { fileRestartResume } from "../agent/run/turn/restart-resume.js";
import { settleRestartPauses } from "../agent/subagents/paused-children.js";
import { createTurnResumeScheduler, resumeInterruptedTurns } from "../agent/run/turn/turn-resume.js";
import { adoptBackgroundJobs } from "../agent/tools/jobs/background-adoption.js";
import { restoreBackgroundJobs, settleLostRuns } from "../agent/tools/jobs/background-jobs.js";
import { onInputWaitStarted } from "../agent/tools/jobs/input-wait-follow.js";
import { restoreWatchers } from "../agent/verification/watchers.js";
import { resumeInterruptedFires } from "../automations/fire-resume.js";
import { resumeWorkflowExecution } from "../workflows/workflow-runner.js";
import { bootFacts, RESTART_STORM, reportRestartStorm } from "../system/boot/boot-history.js";
import type { BootPhase } from "./boot-phase.js";

// Every restart is gated and attempt-bounded; a failure leaves the item on the record as interrupted.
export const startBootResumes = ({ logger, role, services, shutdown }: BootPhase): void => {
    // A spent allowance, a provider outage or a turn that stopped short re-run only on the conversation's own policy.
    const turnResume = createTurnResumeScheduler(services);
    shutdown.push(() => turnResume.stop());
    if (role.roots) {
        turnResume.start();
    }

    // Detached: an interrupted turn is a whole turn, and an interrupted automation fire a whole fire. What waited in a
    // queue goes after them: behind a resumed turn when its conversation has one, at once when it has none. Whether
    // the owner started this restart and asked for its cut turns back is read once, here, for both passes, and so is
    // whether this boot is one of a restart storm, which resumes nothing (system/boot/boot-history.ts, 2026-10-05).
    const ownerAsked = fileRestartResume(services.config.historyRoot)
        .take(Date.now())
        .catch((error: unknown) => {
            logger.warn({ err: error }, "whether the owner asked this restart to resume could not be read, so only the settings decide");
            return false;
        });
    const held = bootFacts().then((facts) => {
        if (facts?.storm !== true) {
            return false;
        }
        logger.warn(
            { boots: facts.bootsInWindow, windowMinutes: RESTART_STORM.windowMs / 60_000, previousBootAt: facts.previousBootAt },
            "boot: a restart storm, so neither a resume ask nor autoResumeOnRestart is honoured this boot; the cut turns stay interrupted",
        );
        reportRestartStorm(services.config.historyRoot, facts);
        return true;
    });
    void Promise.all([ownerAsked, held])
        .then(([asked, storm]) => resumeInterruptedTurns(services, Date.now(), asked, storm))
        .catch((error: unknown) => logger.error({ err: error }, "interrupted turns could not be resumed, they stand on the record as interrupted"))
        .then(() => {
            for (const conversationId of services.agents.ids()) {
                if ((services.agents.entry(conversationId)?.queue?.items.length ?? 0) > 0) {
                    void services.turns.drain(conversationId);
                }
            }
        })
        // A child paused on a re-run the restart dropped stays stopped: its parent is told, once the turns the restart
        // cut are running again, since only a parent with a live turn can be (agent/subagents/paused-children.ts).
        .then(() => (role.roots ? settleRestartPauses(services) : undefined));
    void Promise.all([ownerAsked, held])
        .then(([asked, storm]) => resumeInterruptedFires(services, Date.now(), asked, storm))
        .catch((error: unknown) =>
            logger.error({ err: error }, "interrupted automation fires could not be re-fired, they stand on the record as interrupted"),
        );

    // Each watch is re-checked once, since it may have resolved during the rebuild. First, every run the restart took
    // down has its end written for it, so the watch waiting on it reports the loss at that look rather than at its
    // deadline.
    const restoring = async (): Promise<void> => {
        try {
            const lost = await settleLostRuns();
            if (lost.length > 0) {
                logger.warn({ dirs: lost }, "agent commands the restart took down were written down as lost, their watches report it now");
            }
        } catch (error) {
            logger.warn({ err: error }, "agent commands the restart took down could not be written down, their watches wait out their deadlines");
        }
        await restoreWatchers();
    };
    void restoring().catch((error: unknown) => logger.error({ err: error }, "armed condition watches could not be restored"));

    // Every agent command found sitting at a prompt is on the record as it happens (input-wait.ts), so a turn that stalled
    // on one can be read back from the log rather than pieced together from a transcript.
    onInputWaitStarted((dir, wait) => {
        logger.warn({ dir, program: wait.program, pid: wait.pid, since: wait.since }, "agent command: waiting for input nobody in the sandbox will type");
    });

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
