import { admitTurn, type MemoryHeadroom } from "../../platform/resources/memory-admission.js";

// A child whose runtime was killed under it, told apart from one that failed at its own work: by memory when the OOM
// killer moved during its turn or the box is short now (earlyoom and the host's killer never move the counter), by
// something else outside it otherwise. Both leave its session intact, which is what the parent most needs to hear.

export type KillCause = "memory" | "outside";

// The SDK's own sentences for a runtime that died by signal; 137 and 143 are SIGKILL and SIGTERM through a shell.
const KILLED = /exited with code (?:137|143)\b|terminated by signal SIG(?:KILL|TERM)\b/u;

/** Whether a failure is the child's runtime being killed rather than the child failing. */
export const runtimeKilled = (failure: string): boolean => KILLED.test(failure);

/** Why a killed runtime died, from the OOM count at its turn's start and a reading taken after. */
export const killCauseOf = (after: MemoryHeadroom, oomKillsBefore: number | undefined): KillCause => {
    const killerMoved = oomKillsBefore !== undefined && after.oomKills !== undefined && after.oomKills > oomKillsBefore;
    return killerMoved || !admitTurn(after, true).admit ? "memory" : "outside";
};

/** The ending the parent reads for a killed child: what happened, then the way back. */
export const killNote = (cause: KillCause, failure: string): string =>
    cause === "memory"
        ? `Killed when the sandbox ran out of memory (${failure}). Its session is intact: \`send\` it a message and it carries on ` +
          `from where it stopped, once there is room for it. Starting more agents now meets the same wall; have fewer run at ` +
          `once, and their builds and tests one at a time.`
        : `Killed from outside its turn (${failure}). Its session is intact: \`send\` it a message and it carries on from where it stopped.`;
