import { fileRestartResume } from "../system/restart-resume.js";
import { createTurnResumeScheduler } from "../agent/run/turn/turn-resume.js";
import { nudgeResumesOn } from "../agent/run/turn/holds/resume-nudges.js";
import { type RestartResume, restartResume } from "../agent/run/turn/recovery/restart-resume-policy.js";
import { restoreLimitHolds } from "../conversations/actor/limit-hold.js";
import { onInputWaitStarted } from "../agent/tools/jobs/input-wait-follow.js";
import { logContext } from "../logger.js";
import { bootFacts, RESTART_STORM, reportRestartStorm } from "../system/boot/restarts/boot-history.js";
import { type LeftWork, recoverLeftWork } from "../seams/restart/in-flight.js";
import type { BootPhase } from "./boot-phase.js";
import { inFlightFailed } from "./restart/in-flight-kinds.js";

// Everything a restart cut, recovered in one pass over what was read before the gate opened (bootstrap/restart/in-flight-kinds.ts),
// under the one answer this boot gives to whether any of it comes back. Each kind bounds its own retries; a failure leaves
// its records on file, or on the record as interrupted.
export const startBootResumes = ({ logger, role, services, shutdown }: BootPhase, left: readonly LeftWork[]): void => {
    // First, before anything below can start a turn: a spent allowance's held turn and its booking, kept on the entry.
    try {
        restoreLimitHolds(services);
    } catch (error) {
        logger.error({ err: error }, "held turns a spent allowance stranded could not be put back, their cards wait for a press");
    }
    // A spent allowance, a provider outage or a turn that stopped short re-run only on the conversation's own policy.
    const turnResume = createTurnResumeScheduler(services);
    shutdown.push(() => turnResume.stop());

    // Every agent command found sitting at a prompt is on the record as it happens (input-wait.ts), so a turn that stalled
    // on one can be read back from the log rather than pieced together from a transcript: under the conversation the run
    // belongs to, which the clock that found it (input-wait-follow.ts) cannot know from its own context.
    onInputWaitStarted((dir, wait, owner) => {
        // `childPid`, not `pid`: the logger's own `pid` is the daemon's, and a field of that name overwrote it.
        const line = (): void => logger.warn({ dir, program: wait.program, childPid: wait.pid, since: wait.since }, "agent command: waiting for input nobody in the sandbox will type");
        if (owner === undefined) {
            line();
        } else {
            logContext.run({ conversationId: owner }, line);
        }
    });

    void bootResumePolicy({ logger, services })
        .then(async (resume) => recoverLeftWork(left, resume, inFlightFailed(logger)))
        .finally(() => {
            if (!role.roots) {
                return;
            }
            // Once the children are back, so a re-run it fires on one is adopted. Woken by the events that make a hold due,
            // at the instants it knows, and on a slow backstop (resume-nudges.ts); one pass now, since the holds restored
            // above were recorded before it could hear them.
            turnResume.start();
            shutdown.push(nudgeResumesOn(services, turnResume));
            turnResume.nudge();
        });
};

// The one answer this boot gives every kind of work a restart cut: the owner's ask for this restart, autoResumeOnRestart,
// and whether this boot is one of a restart storm (agent/run/turn/recovery/restart-resume-policy.ts). An ask or a setting that cannot be read counts as not given, so an unreadable
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
