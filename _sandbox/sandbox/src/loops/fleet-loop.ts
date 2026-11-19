import { AgentProviderSchema } from "@intentic/sandbox-contract/schemas/agent";
import type { Loop } from "@intentic/sandbox-contract/schemas/loops";
import { z } from "zod";
import { opt } from "../opt.js";

// WHAT `agents loop` ASKS FOR, and the loop it makes (loops/fleet-loop.routes.ts serves it). A loop was startable only from
// the editor's composer, so an owner who wanted a backlog worked through drove it by hand: one audited sandbox ran the
// same "are there any optimizations left" prompt through nine conversations in a row, each started minutes after the last
// had finished saying "N groups remain", and idle overnight between them (2026-11-19). The shell door lets the owner, or
// an agent the owner asked, start that chain once: a prompt each round is given, ended by a check command, by a round
// counting nothing remaining, or by its ceilings. Every round is a fresh session of the same conversation, seeded with
// the latest messages and where the work stands, and told where the round before it ended (loop-brief.ts).

// Rounds before it gives up when the ask names none: enough for a backlog worked an item a round, not a runaway.
const DEFAULT_ROUNDS = 10;
// Unchanged rounds in a row before it stops: one may be a round that only read, two is a loop going nowhere.
const DEFAULT_STALL = 2;

export const LoopAskSchema = z
    .object({
        // The conversation to loop, as the agent named it; absent opens a new one.
        on: z.string().min(1).optional(),
        prompt: z.string().min(1).max(8_000),
        goal: z.string().min(1).max(2_000).optional(),
        until: z.string().min(1).max(2_000).optional(),
        max: z.number().int().min(1).max(50).optional(),
        stall: z.number().int().min(1).max(10).optional(),
        spendUsd: z.number().positive().optional(),
        provider: AgentProviderSchema.optional(),
        model: z.string().min(1).optional(),
        land: z.boolean().optional(),
    })
    .refine((ask) => (ask.provider === undefined) === (ask.model === undefined), {
        message: "name a provider and a model together, or neither: a model name only means anything to the provider that serves it",
    });
export type LoopAsk = z.infer<typeof LoopAskSchema>;

/** The goal a round is held to: the ask's own words, else what its check or its count says. */
const goalOf = (ask: LoopAsk): string => {
    if (ask.goal !== undefined) {
        return ask.goal;
    }
    return ask.until === undefined ? "Nothing in this job is left to do." : `\`${ask.until}\` exits 0.`;
};

/** The loop an ask makes on its conversation: fresh rounds, each writing whether it is done and how much remains. */
export const loopOfAsk = (ask: LoopAsk, target: { readonly conversationId: string; readonly isolated: boolean }): Loop => ({
    conversationId: target.conversationId,
    goal: goalOf(ask),
    prompt: ask.prompt,
    context: "fresh",
    // A claim every round, so its `reason` and `remaining` reach the next one, whatever else ends the loop.
    output: { kind: "claim" },
    checks: ask.until === undefined ? [] : [{ kind: "command", command: ask.until }],
    maxIterations: ask.max ?? DEFAULT_ROUNDS,
    stallLimit: ask.stall ?? DEFAULT_STALL,
    isolated: target.isolated,
    ...opt("maxSpendUsd", ask.spendUsd),
    ...opt("agent", ask.provider),
    ...opt("model", ask.model),
    ...opt("autoLand", ask.land),
});
