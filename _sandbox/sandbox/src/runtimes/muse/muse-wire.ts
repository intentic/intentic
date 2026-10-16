import { z } from "zod";
import { parseJsonWith } from "@intentic/base/json";

// The slice of the Muse Session Protocol this daemon reads, parsed at the boundary: the notifications a turn renders and
// the answers its commands get. Everything else the host sends is dropped here, unread; a malformed field on a method
// this file knows fails that one notification, never the turn. Names follow the wire (@muse-code/sdk's msp.d.ts).

export type MuseJson = string | number | boolean | null | readonly MuseJson[] | { readonly [key: string]: MuseJson };
export type MuseParams = { readonly [key: string]: MuseJson };

// An answer read for nothing but its arrival: a command whose acceptance is all the loop needs.
export const AcceptedSchema = z.object({}).loose();

export const InitializeAnswerSchema = z.object({
    schema: z.object({ fingerprint: z.string() }),
    serverInfo: z.object({ version: z.string() }),
});

const OutputRefSchema = z.object({ id: z.string() });

const PatchSummarySchema = z.object({ added: z.number(), removed: z.number(), files: z.number() });

const TokenUsageSchema = z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cachedTokens: z.number(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
});
export type MuseTokenUsage = z.infer<typeof TokenUsageSchema>;

// One transcript item at one revision. Open on the wire (kinds, statuses); the fields read here are each optional
// because each belongs to one kind.
const ItemSchema = z.object({
    itemId: z.string(),
    kind: z.string(),
    status: z.string(),
    turnId: z.string().nullish(),
    text: z.string().optional(),
    summary: z.array(z.string()).optional(),
    tool: z.string().optional(),
    args: z.string().optional(),
    visibleOutput: z.string().optional(),
    failureReason: z.string().optional(),
    patchRef: OutputRefSchema.optional(),
    patchSummary: PatchSummarySchema.optional(),
    objective: z.string().optional(),
    result: z.object({ summary: z.string().optional(), text: z.string().optional() }).optional(),
    usage: TokenUsageSchema.optional(),
    trigger: z.string().optional(),
    tokensBefore: z.number().optional(),
    tokensAfter: z.number().optional(),
    fallbackText: z.string().optional(),
});
export type MuseItem = z.infer<typeof ItemSchema>;

const SessionSchema = z.object({ sessionId: z.string(), modelId: z.string().nullish(), providerId: z.string().nullish() });

// What session/start and session/resume both answer, as far as the loop reads it.
export const SessionOpenedSchema = z.object({ session: SessionSchema });

export const TurnStartedAnswerSchema = z.object({ turnId: z.string(), disposition: z.string().optional() });

export const ModelListSchema = z.object({
    providerId: z.string(),
    source: z.string(),
    models: z.array(
        z.object({
            modelId: z.string(),
            displayLabel: z.string(),
            providerId: z.string(),
            contextLimit: z.number().nullable(),
            isDefault: z.boolean(),
            description: z.string().nullable(),
            defaultReasoningEffort: z.string().optional(),
            // A complete ordered effort ladder, or an explicit "unknown" object the reader treats as none.
            variants: z.union([z.array(z.string()), z.object({}).loose()]).optional(),
        }),
    ),
});
export type MuseModelList = z.infer<typeof ModelListSchema>;

const RequirementSchema = z.object({ approvalId: z.string(), sourceIndex: z.number() });
const ChoiceSchema = z.object({
    choiceId: z.string(),
    decision: z.string(),
    label: z.string(),
    scope: z.string(),
    acceptsFeedback: z.boolean().optional(),
});
export type MuseApprovalChoice = z.infer<typeof ChoiceSchema>;

export const ApprovalRequestedSchema = z.object({
    approvalId: z.string(),
    sessionId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    toolName: z.string(),
    rawArgs: z.string(),
    availableChoices: z.array(ChoiceSchema),
    currentRequirementId: RequirementSchema,
    subject: z.object({
        kind: z.string(),
        command: z.string().optional(),
        path: z.string().optional(),
        host: z.string().optional(),
        target: z.string().optional(),
        workspaceRoot: z.string().optional(),
    }),
});
export type MuseApprovalRequest = z.infer<typeof ApprovalRequestedSchema>;

// A multi-stage approval (a compound shell line) advances its requirement through this frame alone.
export const ApprovalUpdatedSchema = z.object({
    approvalId: z.string(),
    sessionId: z.string(),
    availableChoices: z.array(ChoiceSchema),
    currentRequirementId: RequirementSchema,
});

export const ApprovalResolvedSchema = z.object({ approvalId: z.string() });

const QuestionSchema = z.object({
    id: z.string(),
    header: z.string(),
    question: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
    selection: z.object({ mode: z.enum(["single", "multiple"]), minSelections: z.number().optional(), maxSelections: z.number().optional() }),
});
export type MuseQuestion = z.infer<typeof QuestionSchema>;

export const UserInputRequestedSchema = z.object({
    userInputId: z.string(),
    sessionId: z.string(),
    turnId: z.string(),
    questions: z.array(QuestionSchema),
});
export type MuseUserInputRequest = z.infer<typeof UserInputRequestedSchema>;

const TurnErrorSchema = z.object({
    kind: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    quota: z.object({ limitKind: z.string(), resetsAtMs: z.number() }).optional(),
});
export type MuseTurnError = z.infer<typeof TurnErrorSchema>;

// One notification as the host delivered it; its params are read only through readMuseEvent below.
export interface MuseNotification {
    readonly method: string;
    readonly params?: unknown;
}

const event = <M extends string, P extends z.ZodType>(method: M, params: P) => z.object({ method: z.literal(method), params });

const ItemEventSchema = z.object({ item: ItemSchema });

// Every notification the loop acts on, discriminated by its method; any other method is dropped unread.
const MuseEventSchema = z.discriminatedUnion("method", [
    event("item/started", ItemEventSchema),
    event("item/updated", ItemEventSchema),
    event("item/completed", ItemEventSchema),
    // An absent field path means the item's text (tdd SS4.3.1).
    event("item/delta", z.object({ itemId: z.string(), field: z.string().default("text"), delta: z.string() })),
    event("turn/started", z.object({ turnId: z.string() })),
    event(
        "turn/completed",
        z.object({
            turnId: z.string(),
            terminal: z.string(),
            error: TurnErrorSchema.optional(),
            reason: z.string().optional(),
            durationMs: z.number().optional(),
        }),
    ),
    event(
        "turn/retryScheduled",
        z.object({
            turnId: z.string(),
            nextAttempt: z.number(),
            maxAttempts: z.number(),
            retryDelayMs: z.number(),
            httpStatus: z.number().optional(),
            reason: z.string(),
        }),
    ),
    event("session/tokenUsage", z.object({ turnId: z.string(), promptTokens: z.number(), usage: TokenUsageSchema })),
    event("session/contextUsage", z.object({ usedTokens: z.number(), windowTokens: z.number().optional() })),
    event("session/modelChanged", z.object({ modelId: z.string() })),
    event("approval/requested", ApprovalRequestedSchema),
    event("approval/updated", ApprovalUpdatedSchema),
    event("approval/resolved", ApprovalResolvedSchema),
    event("userInput/requested", UserInputRequestedSchema),
    event("userInput/settled", z.object({ userInputId: z.string() })),
]);
export type MuseEvent = z.infer<typeof MuseEventSchema>;

/** The notification as the loop reads it, or undefined for one it does not act on or cannot read. */
export const readMuseEvent = (notification: MuseNotification): MuseEvent | undefined => MuseEventSchema.safeParse(notification).data;

// A tool call's argument JSON, verbatim from the model, read for the few fields a card names. Malformed or another
// shape reads as naming nothing: the model wrote it, and a bad argument is the tool's to refuse.
export const ToolArgsSchema = z
    .object({
        command: z.string().optional(),
        path: z.string().optional(),
        content: z.string().optional(),
        find: z.string().optional(),
        replace: z.string().optional(),
        pattern: z.string().optional(),
        url: z.string().optional(),
        query: z.string().optional(),
        workdir: z.string().optional(),
        session_id: z.string().optional(),
        chars: z.string().optional(),
        plan: z.array(z.object({ step: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })).optional(),
    })
    .catch({});
export type MuseToolArgs = z.infer<typeof ToolArgsSchema>;

export const toolArgsOf = (raw: string | undefined): MuseToolArgs => {
    if (raw === undefined || raw.trim() === "") {
        return {};
    }
    // Almost-JSON from the model names nothing, the same as an absent argument.
    return parseJsonWith(raw, ToolArgsSchema) ?? {};
};

// What a finished shell call carries in its visible output: Muse's own envelope around the command's text and exit.
const ShellResultSchema = z.object({ output: z.string(), exit_code: z.number().optional() });

export const shellResultOf = (visible: string | undefined): z.infer<typeof ShellResultSchema> | undefined => {
    // A shell result that is not Muse's envelope is shown as the text it is.
    return visible === undefined ? undefined : parseJsonWith(visible, ShellResultSchema);
};
