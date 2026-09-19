import { z } from "zod";
import { AgentProviderSchema } from "./agent.js";

// Asked once per chat, on the message it opens with; answers with the model, effort and account that whole
// conversation runs on. Distinct from prompt-complexity.ts, which judges a turn at a time and may only ever name a
// cheaper rung of the provider already picked: this one chooses freely, and only before anything has run.

export const ModelRouteAskSchema = z.object({
    prompt: z.string().min(1).max(20000).describe("The message a new chat is about to open with."),
    paths: z
        .array(z.string().min(1).max(500))
        .max(50)
        .default([])
        .describe("Workspace paths the message names: uploads, @-mentions, the editor's own file. How much real code the work touches."),
    editorContext: z.boolean().optional().describe("Whether the message carries a file and selection the user pointed at, so it is about real code."),
    planMode: z.boolean().optional().describe("Whether the chat opens in plan mode, which is a request to think before acting."),
});
export type ModelRouteAsk = z.infer<typeof ModelRouteAskSchema>;

export const ModelPickSchema = z.object({
    provider: AgentProviderSchema.describe("Which provider serves the conversation."),
    model: z.string().min(1).describe("Which of its models."),
    effort: z.string().optional().describe("How hard it should think, where the model offers a choice. Absent takes the model's own default."),
    account: z
        .string()
        .optional()
        .describe("Which connected account pays, by its daemon-minted id. Absent leaves it to whichever account has the most headroom."),
});
export type ModelPick = z.infer<typeof ModelPickSchema>;

export const ModelRouteSchema = z.object({
    // Absent is a real, safe answer: the chat runs on whatever the picker remembered, and says why nothing moved.
    pick: ModelPickSchema.optional().describe("What the conversation should run on, or absent when nothing could be chosen and the usual pick stands."),
    reason: z.string().describe("Why, in the one line a chat can show. Present whether or not a model was named."),
    // Absent means nothing was spent: the role was unset, every rung refused, or the deadline passed first.
    judge: z
        .string()
        .optional()
        .describe(
            "Which model answered, as `provider:model`, so the chat can name what the reading cost. Absent when no model was reached at all.",
        ),
});
export type ModelRoute = z.infer<typeof ModelRouteSchema>;
