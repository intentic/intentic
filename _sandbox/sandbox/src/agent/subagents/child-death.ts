// A child whose runtime was killed under it, told apart from one that failed at its own work: by memory when the OOM
// killer moved during its turn or the budget's sampler saw the box short in the last few minutes (earlyoom and the host's
// killer never move the counter), by
// something else outside it otherwise. Both leave its session intact, which is what the parent most needs to hear.

export type KillCause = "memory" | "outside";

// The SDK's own sentences for a runtime that died by signal; 137 and 143 are SIGKILL and SIGTERM through a shell.
const KILLED = /exited with code (?:137|143)\b|terminated by signal SIG(?:KILL|TERM)\b/u;

/** Whether a failure is the child's runtime being killed rather than the child failing. */
export const runtimeKilled = (failure: string): boolean => KILLED.test(failure);

// What the resource budget saw around the death: the OOM count now, and whether any recent reading was short.
export interface DeathWitness {
    readonly oomKills: number | undefined;
    readonly shortRecently: boolean;
}

/** Why a killed runtime died, from the OOM count at its turn's start and what the budget saw since. */
export const killCauseOf = (after: DeathWitness, oomKillsBefore: number | undefined): KillCause => {
    const killerMoved = oomKillsBefore !== undefined && after.oomKills !== undefined && after.oomKills > oomKillsBefore;
    return killerMoved || after.shortRecently ? "memory" : "outside";
};

/** The ending the parent reads for a killed child: what happened, then the way back. */
export const killNote = (cause: KillCause, failure: string): string =>
    cause === "memory"
        ? `Killed when the sandbox ran out of memory (${failure}). Its session is intact: \`send\` it a message and it carries on ` +
          `from where it stopped, once there is room for it. Starting more agents now meets the same wall; have fewer run at ` +
          `once, and their builds and tests one at a time.`
        : `Killed from outside its turn (${failure}). Its session is intact: \`send\` it a message and it carries on from where it stopped.`;
