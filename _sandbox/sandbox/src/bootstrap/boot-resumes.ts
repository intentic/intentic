import { fileRestartResume } from "../system/restart-resume.js";
import { settleRestartPauses } from "../agent/subagents/paused-children.js";
import { restoreSpawnedChildren, settleRestoredChildren } from "../agent/subagents/child-restore.js";
import { resumeScriptRuns } from "../agent/subagents/workflows/script-runs.js";
import { createTurnResumeScheduler, resumeInterruptedTurns } from "../agent/run/turn/turn-resume.js";
import { type RestartResume, restartResume } from "../agent/run/turn/restart-resume-policy.js";
import { restoreLimitHolds } from "../conversations/actor/limit-hold.js";
import { adoptBackgroundJobs } from "../agent/tools/jobs/background-adoption.js";
import { restoreBackgroundJobs, settleLostRuns } from "../agent/tools/jobs/background-jobs.js";
import { onInputWaitStarted } from "../agent/tools/jobs/input-wait-follow.js";
import { restoreWatchers } from "../agent/verification/watchers.js";
import { resumeAutomationInboxes, resumeInterruptedFires } from "../automations/fire-resume.js";
import { resumeWorkflowExecution } from "../workflows/workflow-runner.js";
import { bootFacts, RESTART_STORM, reportRestartStorm } from "../system/boot/restarts/boot-history.js";
import type { BootPhase } from "./boot-phase.js";

// Every restart is gated and attempt-bounded; a failure leaves the item on the record as interrupted.
export const startBootResumes = ({ logger, role, services, shutdown }: BootPhase): void => {
    // First, before anything below can start a turn: a spent allowance's held turn and its booking, kept on the entry.
    try {
        restoreLimitHolds(services);
    } catch (error) {
        logger.error({ err: error }, "held turns a spent allowance stranded could not be put back, their cards wait for a press");
    }
    // The spawned children their parents supervise, read back before anything below can start a turn on one: a re-run
    // the scheduler fires or a turn the restart cut is adopted only where its record is back (agent/subagents/children.ts).
    const restoredChildren = restoreSpawnedChildren(services);
    // A spent allowance, a provider outage or a turn that stopped short re-run only on the conversation's own policy.
    const turnResume = createTurnResumeScheduler(services);
    shutdown.push(() => turnResume.stop());
    if (role.roots) {
        void restoredChildren.then(() => turnResume.start());
    }

    // Detached: an interrupted turn is a whole turn, an interrupted automation fire a whole fire, and a stranded loop or
    // workflow run a whole run. What waited in a queue goes after the turns: behind a resumed turn when its conversation
    // has one, at once when it has none. Whether any of it comes back is decided once, here, for all three passes
    // (agent/run/turn/restart-resume-policy.ts): the owner's ask for this restart, autoResumeOnRestart, and whether this
    // boot is one of a restart storm, which resumes nothing (system/boot/boot-history.ts, 2026-10-05).
    const policy = bootResumePolicy({ logger, services });
    void Promise.all([policy, restoredChildren])
        .then(([resume]) => resumeInterruptedTurns(services, Date.now(), resume))
        .catch((error: unknown) => logger.error({ err: error }, "interrupted turns could not be resumed, they stand on the record as interrupted"))
        .then(() => {
            for (const conversationId of services.agents.ids()) {
                if ((services.agents.entry(conversationId)?.queue?.items.length ?? 0) > 0) {
                    void services.turns.drain(conversationId);
                }
            }
        })
        .then(() => settleCutChildren({ role, services }, restoredChildren));
    void policy
        .then((resume) => resumeInterruptedFires(services, Date.now(), resume))
        .catch((error: unknown) =>
            logger.error({ err: error }, "interrupted automation fires could not be re-fired, they stand on the record as interrupted"),
        )
        .then(() => resumeAutomationInboxes(services));

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
        // `childPid`, not `pid`: the logger's own `pid` is the daemon's, and a field of that name overwrote it.
        logger.warn({ dir, program: wait.program, childPid: wait.pid, since: wait.since }, "agent command: waiting for input nobody in the sandbox will type");
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

    void resumeCutRuns({ role, services }, policy, restoredChildren);

    // The coordinator reserves workflow-owned conversations before generic loop recovery sees the rest.
    void policy.then(async (resume) => resumeWorkflowExecution(services, resume)).catch((error: unknown) => logger.error({ err: error }, "loops and workflow runs could not be resumed"));
};

// Once the turns the restart cut are running again, since only a parent with a live turn can hear it: a child paused on a
// re-run the restart dropped stays stopped (agent/subagents/paused-children.ts), and so does one whose turn the restart
// cut and that did not come back, said on its row and to its parent (agent/subagents/children.ts). Neither throws.
const settleCutChildren = async ({ role, services }: Pick<BootPhase, "role" | "services">, restored: Promise<readonly string[]>): Promise<void> => {
    if (!role.roots) {
        return;
    }
    await settleRestartPauses(services);
    await settleRestoredChildren(services, await restored);
};

// Workflow runs a restart cut, once their workers' records are back (agent/subagents/workflows/script-runs.ts): each goes on where
// it was, its finished calls handed back and its workers still working waited on, as the restart's answer says. Never
// throws.
const resumeCutRuns = async (
    { role, services }: Pick<BootPhase, "role" | "services">,
    policy: Promise<RestartResume>,
    restored: Promise<readonly string[]>,
): Promise<void> => {
    if (!role.roots) {
        return;
    }
    const [resume] = await Promise.all([policy, restored]);
    await resumeScriptRuns(services, resume);
};

// The one answer this boot gives every resume pass: the owner's ask for this restart, autoResumeOnRestart, and whether
// this boot is one of a restart storm. An ask or a setting that cannot be read counts as not given, so an unreadable
// file never restarts work nobody asked back.
const bootResumePolicy = async ({ logger, services }: Pick<BootPhase, "logger" | "services">): Promise<RestartResume> => {
    const [ownerAsked, storm, autoResumeOnRestart] = await Promise.all([
        readOrFalse(logger, () => fileRestartResume(services.config.historyRoot).take(Date.now()), "whether the owner asked this restart to resume could not be read, so only the settings decide"),
        bootFacts().then((facts) => {
            if (facts?.storm !== true) {
                return false;
            }
            logger.warn(
                { boots: facts.bootsInWindow, windowMinutes: RESTART_STORM.windowMs / 60_000, previousBootAt: facts.previousBootAt },
                "boot: a restart storm, so neither a resume ask nor autoResumeOnRestart is honoured this boot; the cut turns, fires, loops and workflow runs stay interrupted",
            );
            reportRestartStorm(services.config.historyRoot, facts);
            return true;
        }),
        readOrFalse(
            logger,
            async () => (await services.sandboxSettings.get()).autoResumeOnRestart,
            "settings unreadable at boot, so nothing the restart cut is resumed unless the owner asked",
        ),
    ]);
    return restartResume({ ownerAsked, storm, autoResumeOnRestart });
};

// A yes that could not be read is a no, said in the log.
const readOrFalse = async (logger: BootPhase["logger"], read: () => Promise<boolean>, saying: string): Promise<boolean> => {
    try {
        return await read();
    } catch (error) {
        logger.warn({ err: error }, saying);
        return false;
    }
};
