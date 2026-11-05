import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import type { Services } from "../../../composition.js";
import { limitReopensAt, standingReopensAt } from "../../models/limit-reset.js";
import { limitWayOf } from "../../models/limit-way.js";
import { witnessedKillCause } from "../../subagents/child-death.js";
import { memoryRerunsMade, ownKillOf, recentMemoryKills } from "../turn/holds/memory-kill.js";
import type { FailureQueries } from "./classify-failure.js";
import type { MemoryDeath } from "./memory-death.js";

// The questions a failure's classification asks of the daemon's own records rather than of a conversation: when a spent
// allowance reopens, the way on, which routed sign-ins wait on their owner, and whether memory killed a dead runtime.
// Every request a runtime runs has these; a conversation's own two (its break policy and its stop ladder) are added where
// there is one (stream-agent.ts).
export type RecordQueries = Omit<FailureQueries, "breakPolicy" | "stopLadder">;

export const recordQueries = (services: Services): RecordQueries => ({
    reopensAt: (at) => limitReopensAt({ services, ...at }),
    standingReopensAt: (at) => standingReopensAt({ services, ...at }),
    limitWay: (params) => limitWayOf(services, params),
    awaitingVerification: async (provider) => {
        const keyed = KeyedProviderSchema.safeParse(provider);
        if (!keyed.success) {
            return [];
        }
        return (await services.cliProxy.accounts())[keyed.data].flatMap((account) => (account.cooling?.verify === undefined ? [] : [account.label]));
    },
    memoryDeath: (conversationId, turn, now) => memoryDeathOf(services, conversationId, turn, now),
});

/**
 * Whether memory killed a runtime that died under a conversation's turn, by evidence tied to this death: a kill on
 * record in the last few minutes of a process this conversation started (memory-kill.ts ownKillOf: the owner stamp its
 * runtime and everything under it carry, so the runtime itself or anything it ran), else the budget's own witness, the
 * OOM counter moving during a child's turn or a reading short in the last few minutes (child-death.ts, as a child's
 * parent is told). Another conversation's kill alone is not: a runaway killed elsewhere says nothing of why this runtime
 * died, and reading it so held every death of those minutes for room. The kills are handed on either way, so a death
 * the witness calls memory's names the largest of them as what was found. A record that cannot be read is said in the
 * log and judged as no kill, and a witness that cannot be read leaves the death a stop, as it always was: holding a turn
 * for room on a guess would hold it for nothing.
 */
const memoryDeathOf = async (
    services: Services,
    conversationId: string,
    turn: { readonly prompt: string; readonly messageId?: string | undefined; readonly memoryReruns?: number | undefined },
    now: number,
): Promise<MemoryDeath | undefined> => {
    const kills = await recentMemoryKills(services.config.historyRoot, now).catch((error: Error) => {
        services.logger.warn({ err: error, conversationId }, "turn failed: the memory kills on record could not be read, the runtime's death is judged by the budget alone");
        return [];
    });
    const own = ownKillOf(kills, conversationId);
    const cause =
        own === undefined
            ? await witnessedKillCause(services, conversationId).catch((error: Error) => {
                  services.logger.warn({ err: error, conversationId }, "turn failed: the budget's readings could not be read, the killed runtime is held as a stop");
                  return undefined;
              })
            : "memory";
    // The count rides on the turn too (memory-kill.ts memoryRerunsOf), for a re-run that outlived a restart, which took the holding.
    const reruns = Math.max(memoryRerunsMade(services.conversations, conversationId, turn), turn.memoryReruns ?? 0);
    return cause === undefined ? undefined : { cause, kills, own, reruns };
};
