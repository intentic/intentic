import { z } from "zod";
import { AskQuestionSchema } from "../events/requests.js";
import { entryId } from "./internal.js";

// LINKED SANDBOXES: one of the owner's sandboxes handing tasks to another. The sandbox that hands work over holds a
// `link` capability card (schemas/capabilities.ts LinkConfigSchema); the one that takes it holds an inbound link, minted
// by its owner, whose token is that card's credential. Everything the taking side does with a task is decided there, by
// the terms on its own link: which persona the work wears, whether each task waits for its owner, how many turns an hour.
// The handing side only asks, reads and stops.

// What a link token looks like: issuer-prefixed like a control token (`ict_`), and never the same credential.
export const LINK_TOKEN_PREFIX = "ilk_";
// The header the taking sandbox's link doors read it from.
export const LINK_HEADER = "x-intentic-link";
// How many links a task may have crossed before the one it is asking across. A task a person started is at 0; a sandbox
// that took a task through a link and hands part of it on asks at 1. Past this the asking sandbox refuses before it
// calls, and the taking sandbox refuses again, so two sandboxes cannot hand one task back and forth for ever.
export const LINK_MAX_HOPS = 2;
// The ceiling a link's own hourly allowance may be set to, and what one is minted with when its owner names none.
export const LINK_TURNS_PER_HOUR_MAX = 120;
export const LINK_TURNS_PER_HOUR_DEFAULT = 20;

// THE TERMS, set on the taking side and enforced there: what the asking side is told, never what it decides.
export const LinkTermsSchema = z.object({
    actsAs: entryId
        .optional()
        .describe(
            "The persona every task through this link wears: its accounts, its shelves, its folders, its model. Absent, the task runs with no signed-in account and the full toolbox, as any unattended wake does.",
        ),
    approve: z
        .boolean()
        .default(false)
        .describe("Each new task waits for this sandbox's owner to allow it before anything runs. Follow-up messages to a task already allowed do not."),
    turnsPerHour: z
        .number()
        .int()
        .min(1)
        .max(LINK_TURNS_PER_HOUR_MAX)
        .default(LINK_TURNS_PER_HOUR_DEFAULT)
        .describe("How many turns the link may start in an hour, new tasks and follow-ups alike. Words said into a turn already running are not counted."),
});
export type LinkTerms = z.infer<typeof LinkTermsSchema>;

// Where the link's holder says it is, as the owner's editor named it at pairing; informational, never a credential.
export const LinkPeerSchema = z.object({
    sandboxId: z.string().max(100).optional().describe("The asking sandbox's id on the owner's account."),
    url: z.string().max(500).optional().describe("The asking sandbox's own address."),
});
export type LinkPeer = z.infer<typeof LinkPeerSchema>;

// A task waiting for the taking sandbox's owner, when the link's terms say every task waits.
export const LinkRequestSchema = z.object({
    id: z.string().describe("The task's own id, the one the asking sandbox gave it."),
    conversationId: z.string().describe("The conversation the task opens here once it is allowed."),
    task: z.string().describe("What it asks, cut to a readable length."),
    title: z.string().optional().describe("Its one-line name."),
    askedAt: z.number().describe("When it arrived, in epoch milliseconds."),
});
export type LinkRequest = z.infer<typeof LinkRequestSchema>;

// One inbound link as the owner's Access page lists it: everything but the token, which is kept only as a hash.
export const InboundLinkSummarySchema = z.object({
    id: z.string(),
    label: z.string().describe("What the asking sandbox is called here: its name at pairing, or what the owner typed."),
    from: LinkPeerSchema.optional(),
    terms: LinkTermsSchema,
    createdAt: z.number(),
    createdBy: z.string().optional().describe("The owner who minted it."),
    lastUsedAt: z.number().optional().describe("The last time it was used, coarse on purpose; absent means never."),
    conversations: z.number().int().nonnegative().describe("How many conversations it has opened here."),
    requests: z.array(LinkRequestSchema).describe("Tasks waiting for the owner's yes, oldest first."),
});
export type InboundLinkSummary = z.infer<typeof InboundLinkSummarySchema>;
export const InboundLinksListSchema = z.object({ links: z.array(InboundLinkSummarySchema) });
export type InboundLinksList = z.infer<typeof InboundLinksListSchema>;

// POST /system/links: what the owner (or their editor, pairing two of their sandboxes) mints a link with.
export const InboundLinkMintSchema = z.object({
    label: z.string().trim().min(1).max(60),
    from: LinkPeerSchema.optional(),
    terms: LinkTermsSchema.partial().optional(),
});
export type InboundLinkMint = z.infer<typeof InboundLinkMintSchema>;
// The raw token, shown exactly once.
export const InboundLinkMintedSchema = z.object({ id: z.string(), token: z.string() });
export type InboundLinkMinted = z.infer<typeof InboundLinkMintedSchema>;
// POST /system/links/{id}: new terms, whole fields replaced, the rest kept.
export const InboundLinkTermsUpdateSchema = LinkTermsSchema.partial().extend({ label: z.string().trim().min(1).max(60).optional() });
export type InboundLinkTermsUpdate = z.infer<typeof InboundLinkTermsUpdateSchema>;
// POST /system/links/{id}/requests/{request}: the owner's answer to one waiting task.
export const LinkRequestDecisionSchema = z.object({ approve: z.boolean() });
export type LinkRequestDecision = z.infer<typeof LinkRequestDecisionSchema>;

/* THE LINK DOORS, called by the asking sandbox's daemon with the link token, never by a browser. */

// GET /link: the link still works, and what it is held to.
export const LinkHelloSchema = z.object({
    sandbox: z.string().describe("What the taking sandbox calls itself."),
    link: z.object({ id: z.string(), label: z.string() }),
    terms: z.object({
        approve: z.boolean(),
        turnsPerHour: z.number().int(),
        persona: z.string().optional().describe("The name of the persona its tasks wear, when they wear one."),
    }),
    maxHops: z.number().int(),
});
export type LinkHello = z.infer<typeof LinkHelloSchema>;

// POST /link/conversations: one task, opening one conversation. `requestId` is the asking side's own id for it: asking
// again under the same id answers with what became of the first ask, so a lost answer never opens a second conversation.
export const LinkTaskSchema = z.object({
    requestId: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
    task: z.string().min(1).max(60_000).describe("The whole task, self-contained: the taking agent sees nothing else."),
    title: z.string().max(80).optional().describe("A one-line name for the conversation it opens."),
    hops: z.number().int().min(0).max(10).default(0).describe("How many links the task already crossed before this one."),
    tainted: z
        .string()
        .max(500)
        .optional()
        .describe("What outside content the asking turn had taken in, when it had: the taking turn carries it on."),
    from: z
        .object({
            conversation: z.string().max(100).optional(),
            title: z.string().max(200).optional(),
        })
        .optional()
        .describe("The asking conversation, for the taking sandbox's own record."),
});
export type LinkTask = z.infer<typeof LinkTaskSchema>;

// Where a linked task stands, as the asking side reads it.
// held: waiting for the taking sandbox's owner to allow it. running: a turn is working on it. blocked: parked on a card;
// `question` carries one the asking agent may answer, anything else waits for the taking sandbox's owner. finished: its
// last turn ended, `report` is what it said. failed: its last turn failed. declined: the owner said no. stopped: the
// asking side stopped it, or its owner did.
export const LinkTaskStateSchema = z.enum(["held", "running", "blocked", "finished", "failed", "declined", "stopped"]);
export type LinkTaskState = z.infer<typeof LinkTaskStateSchema>;

export const LinkQuestionSchema = z.object({
    requestId: z.string(),
    questions: z.array(AskQuestionSchema),
});
export type LinkQuestion = z.infer<typeof LinkQuestionSchema>;

export const LinkTaskStatusSchema = z.object({
    conversationId: z.string(),
    state: LinkTaskStateSchema,
    title: z.string().optional(),
    report: z.string().optional().describe("The last settled turn's closing message, whole."),
    question: LinkQuestionSchema.optional(),
    waitingOn: z.string().optional().describe("What a blocked task waits on when it is not a question the asking agent may answer."),
    error: z.string().optional(),
    // Moves every time anything above changes, so a long poll can wait for a version it has not seen.
    version: z.number().int().nonnegative(),
    updatedAt: z.number(),
});
export type LinkTaskStatus = z.infer<typeof LinkTaskStatusSchema>;

// POST /link/conversations/{id}/messages: follow-up words, said into the running turn or opening the next one.
export const LinkMessageSchema = z.object({
    message: z.string().min(1).max(60_000),
    messageId: z.string().min(1).max(128).optional(),
    tainted: z.string().max(500).optional(),
});
export type LinkMessage = z.infer<typeof LinkMessageSchema>;
export const LinkMessageReceiptSchema = z.object({
    delivered: z.enum(["started", "steered", "queued"]),
});
export type LinkMessageReceipt = z.infer<typeof LinkMessageReceiptSchema>;

// POST /link/conversations/{id}/answer: picks for the question the task is parked on, and only a question.
export const LinkAnswerSchema = z.object({
    requestId: z.string().min(1),
    answers: z.record(z.string(), z.array(z.string())),
});
export type LinkAnswer = z.infer<typeof LinkAnswerSchema>;
