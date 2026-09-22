import { z } from "zod";
import { AgentProviderSchema } from "./agent.js";
import { entryId } from "./internal.js";

// One reading, asked once per chat on the message it opens with, answering whichever of two questions the chat still
// has: which persona handles it, and what it runs on. Both are the same classification over lists the sandbox supplies,
// both are only answerable before anything has run, and neither is worth a model call of its own — so there is one
// call, and `model`/`persona` on the ask say which halves it is being paid to answer.

export const ChatRouteAskSchema = z.object({
    prompt: z.string().min(1).max(20000).describe("The message a new chat is about to open with."),
    paths: z
        .array(z.string().min(1).max(500))
        .max(50)
        .default([])
        .describe("Workspace paths the message names: uploads, @-mentions, the editor's own file. How much real code the work touches, and which persona's ground it stands on."),
    folder: z.string().max(200).optional().describe("The workspace folder the chat was opened in, when it was opened in one."),
    editorContext: z.boolean().optional().describe("Whether the message carries a file and selection the user pointed at, so it is about real code."),
    planMode: z.boolean().optional().describe("Whether the chat opens in plan mode, which is a request to think before acting."),
    // The two halves, each a fact about THIS chat rather than a setting: a chat already pointed at a model or a persona
    // by hand has nothing left to ask about it, whatever the sandbox's settings say.
    model: z.boolean().describe("Whether to choose the model, effort and account: true when the chat is on Auto and nothing has been picked by hand."),
    persona: z.boolean().describe("Whether to choose the persona: true when persona matching is on and the chat has not been pointed at one by hand."),
});
export type ChatRouteAsk = z.infer<typeof ChatRouteAskSchema>;

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

// Absent `id` is a real, safe answer: the chat stays open to every account, and the reason says why nothing was named.
export const PersonaVerdictSchema = z.object({
    id: entryId.optional().describe("The persona this message belongs to, or absent when none does."),
    reason: z.string().describe("Why, in the one clause a chat can show. Present whether or not a persona was named."),
});

// Absent `pick` is a real, safe answer: the chat runs on whatever the picker remembered, and the reason says why.
export const ModelVerdictSchema = z.object({
    pick: ModelPickSchema.optional().describe("What the conversation should run on, or absent when nothing could be chosen and the usual pick stands."),
    reason: z.string().describe("Why, in the one clause a chat can show. Present whether or not a model was named."),
});

// One verdict per half asked for; a half that wasn't asked is absent, never a verdict with an empty answer.
export const ChatRouteSchema = z.object({
    persona: PersonaVerdictSchema.optional().describe("The persona half's answer, present only when it was asked for."),
    model: ModelVerdictSchema.optional().describe("The model half's answer, present only when it was asked for."),
    // Absent means nothing was spent: a folder match, the only runnable model, an unset role, a spent chain, or the
    // deadline passing before any rung answered.
    judge: z
        .string()
        .optional()
        .describe("Which model answered, as `provider:model`, so the chat can name what the reading cost. Absent when no model was reached at all."),
});
export type ChatRoute = z.infer<typeof ChatRouteSchema>;
