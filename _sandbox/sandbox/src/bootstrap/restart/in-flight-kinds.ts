import type { Logger } from "pino";
import { cutChildrenInFlight, spawnedChildrenInFlight } from "../../agent/subagents/child-restore.js";
import { scriptRunsInFlight } from "../../agent/subagents/workflows/script-runs.js";
import { interruptedTurnsInFlight } from "../../agent/run/turn/turn-resume.js";
import { backgroundJobsInFlight, keptJobsInFlight } from "../../agent/tools/jobs/jobs-in-flight.js";
import { watchesInFlight } from "../../agent/verification/watchers.js";
import { automationInboxesInFlight, interruptedFiresInFlight } from "../../automations/fire-resume.js";
import type { Services } from "../../composition.js";
import { type InFlight, type InFlightFailed, type LeftWork, readLeftWork } from "../../seams/restart/in-flight.js";
import { workflowsInFlight } from "../../workflows/workflow-runner.js";
import type { BootPhase } from "../boot-phase.js";

// EVERY KIND OF WORK A RESTART CAN CUT (seams/restart/in-flight.ts), in the order boot recovers it: a kind stands on what the
// kinds before it put back. A new kind of in-flight work declares its records and its recovery beside its store and is
// listed here; it writes no boot pass and no "is this mine" test of its own.
const IN_FLIGHT: readonly InFlight<Services>[] = [
    // A parent's children, their records and roster rows, before any turn that could be one of theirs is adopted.
    spawnedChildrenInFlight,
    // The agent commands still running, and the ends of those the restart took down, before a turn resumes beside them.
    backgroundJobsInFlight,
    interruptedTurnsInFlight,
    // Once the turns that came back are running: only a parent with a live turn hears what became of its child.
    cutChildrenInFlight,
    scriptRunsInFlight,
    interruptedFiresInFlight,
    // After the fires, which take back the inbox rows they had already admitted.
    automationInboxesInFlight,
    // After the background jobs, whose lost ends a watch on one reads at its first look.
    watchesInFlight,
    workflowsInFlight,
    keptJobsInFlight,
];

// What the log says of a kind the pass could not read or recover; the pass goes on to the next either way.
export const inFlightFailed =
    (logger: Pick<Logger, "error">): InFlightFailed =>
    (kind, stage, error) =>
        logger.error(
            { err: error, kind },
            stage === "read" ? "boot: work a restart cut could not be read, it waits on file for the next boot" : "boot: work a restart cut could not be recovered",
        );

/**
 * Reads every kind this daemon's claim recovers, before the gate opens (main.ts): nothing in this process has started a
 * turn, a fire or a child yet, so everything on file was left by an earlier one.
 */
export const readInFlight = async ({ logger, role, services }: Pick<BootPhase, "logger" | "role" | "services">): Promise<readonly LeftWork[]> => {
    const left = await readLeftWork(
        services,
        IN_FLIGHT.filter((kind) => kind.claim === undefined || role[kind.claim]),
        inFlightFailed(logger),
    );
    const cut = left.filter((work) => work.count > 0);
    if (cut.length > 0) {
        logger.info({ left: Object.fromEntries(cut.map((work) => [work.name, work.count])) }, "boot: work a restart cut, read before the gate opens");
    }
    return left;
};
