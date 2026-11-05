import { errorMessage } from "@intentic/base/errors";
import { supervisorOf } from "../../auth/principal.js";
import { type MemoryRestart, memoryRestartOf } from "../../agent/run/turn/recovery/restart-resume-policy.js";
import type { PostMortem } from "../../system/resources/memory-records.js";
import type { BootPhase } from "../boot-phase.js";

// What the boot reads to tell a restart memory caused from any other (agent/run/turn/recovery/restart-resume-policy.ts):
// the post-mortem of the run before this one, drawn from what netd and the kernel recorded around its end
// (system/boot/restarts/post-mortem.ts), undefined after a clean stop. Passed in, so a suite stubs it.
export interface MemoryRestartReads {
    readonly readPostMortem: (historyRoot: string) => Promise<PostMortem | undefined>;
}

/**
 * What a restart memory caused decides for the turns it cut, or undefined for any other restart (a clean stop has no
 * post-mortem at all), which then behaves exactly as before. A post-mortem that cannot be read is said in the log and
 * counts as none, so the cut turns go by autoResumeOnRestart as they always did rather than by a cause nobody could read.
 */
export const readMemoryRestart = async ({ logger, services }: Pick<BootPhase, "logger" | "services">, reads: MemoryRestartReads): Promise<MemoryRestart | undefined> => {
    let postMortem: PostMortem | undefined;
    try {
        postMortem = await reads.readPostMortem(services.config.historyRoot);
    } catch (error) {
        logger.warn({ err: error, reason: errorMessage(error) }, "boot: the post-mortem of the unclean stop could not be read, so the turns it cut go by autoResumeOnRestart");
        return undefined;
    }
    const memory = memoryRestartOf(postMortem, (conversationId) => supervisorOf(services.agents.entry(conversationId)?.identity ?? {}));
    if (memory !== undefined && postMortem !== undefined) {
        logger.warn(
            { cause: postMortem.cause, culprits: [...memory.culprits], killed: postMortem.killed.length, summary: memory.summary },
            "boot: the restart ran out of memory, so the turns it cut go back one at a time once memory settles, on each conversation's answer to a memory kill, and the conversations whose own process was killed wait for a press",
        );
    }
    return memory;
};
