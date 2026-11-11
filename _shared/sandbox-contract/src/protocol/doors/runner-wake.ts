import { z } from "zod";
import { MessageReceiptSchema } from "../../schemas/agent.js";
import { TurnErrandSchema } from "../../schemas/speaker.js";

// The wake door: words the runner's own sandbox has for a conversation its parent dispatched there (a watch that fired,
// a background job that ended, a child's report), handed to the parent, which owns the conversation. The parent says
// them as it would its own wake, so the turn they start is dispatched from the parent like any other: the parent's card,
// board and record follow it, and its work comes back to land. Kept apart from runner-protocol.ts, which schemas/agent.ts
// imports and so cannot import the receipt from.
export const runnerWakeUrl = (parentUrl: string): string => `${parentUrl.replace(/\/$/, "")}/system/runners/wake`;

export const RunnerWakeRequestSchema = z.object({
    conversationId: z.string().min(1),
    prompt: z.string(),
    // Nobody at a composer: the runner's sandbox, or an agent there (a child reporting).
    voice: z.enum(["sandbox", "agent"]),
    // The source of outside content in the prompt; whatever turn it reaches is tainted by it.
    outside: z.string().optional(),
    errand: TurnErrandSchema.optional(),
    // What on the runner sent it (`automation:<id>`, a job), said on the row it opens.
    source: z.string().optional(),
    // The id its words wait under, so the same wake sent twice is delivered once.
    messageId: z.string().optional(),
});
export type RunnerWakeRequest = z.infer<typeof RunnerWakeRequestSchema>;

// `forwarded: false`: the conversation is not one the parent dispatched to this runner, so the runner keeps the wake.
// Otherwise what the parent did with it: a receipt, or why it took nothing (`invalid`, `why`), as a local wake answers.
export const RunnerWakeAnswerSchema = z.union([
    z.object({ forwarded: z.literal(false) }),
    z.object({
        forwarded: z.literal(true),
        said: z.union([MessageReceiptSchema, z.object({ invalid: z.string() }), z.object({ why: z.string() })]),
    }),
]);
export type RunnerWakeAnswer = z.infer<typeof RunnerWakeAnswerSchema>;
