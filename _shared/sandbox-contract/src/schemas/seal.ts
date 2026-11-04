// seal: private conversations (docs/architecture/access.md, "Private conversations"). A conversation's WORDS can be
// sealed to the people its author names; its WORK is not: the diff stays on the board for whoever lands it, and what lands
// is the team's. A person who cannot read a sealed conversation sees it as a calendar shows someone else's private
// event: whose it is, which lane it stands in, and its diff once there is work to land. Never its title.
//
// The owner reads a sealed conversation the way anyone else does, by asking its author. The one other door is opening it
// without asking: the sandbox owner alone (never Full access, never an agent), with a written reason and the owner's
// passkey over it, read-only for a day, told to the author at once and recorded on the conversation for good.
import { z } from "zod";

// ---- The house rule ----

// `everyone`: every conversation is readable by everyone who can see its part of the workspace, as before private
// conversations existed; no new one can be made private. `chooses`: each author decides, new conversations starting as
// their own default says. `private`: new conversations start private, and the author may share one.
// Changing the rule never opens a conversation that is already private: only its author or an opening does.
export const SealModeSchema = z.enum(["everyone", "chooses", "private"]);
export type SealMode = z.infer<typeof SealModeSchema>;
export const SEAL_MODE_DEFAULT: SealMode = "everyone";

// What GET /seal answers: the house rule as it binds, and what the caller's own new conversations start as.
export const SealHouseSchema = z.object({
    mode: SealModeSchema.describe("The house rule: who reads whose conversations in this sandbox."),
    locked: z
        .boolean()
        .describe("Whether the sandbox's organisation fixed the house rule, so nobody here can change it. False on a sandbox no organisation holds."),
    twoPerson: z
        .boolean()
        .describe(
            "Whether opening a private conversation without asking also needs a second person with Full access to agree, as the sandbox's organisation requires.",
        ),
    hosted: z
        .boolean()
        .describe(
            "Whether intentic runs this sandbox, so nobody here has a shell on the machine beneath it. False for a sandbox on the owner's own computer or server, where a shell on that machine can read its files.",
        ),
    sealed: z.number().int().min(0).describe("How many conversations are private right now, live and archived."),
    startsPrivate: z.boolean().describe("Whether a conversation the caller starts now begins private."),
    ownDefault: z
        .boolean()
        .optional()
        .describe("The caller's own answer to whether their new conversations start private, when the house rule lets them choose. Absent: never answered."),
});
export type SealHouse = z.infer<typeof SealHouseSchema>;

export const SealSetHouseSchema = z.object({ mode: SealModeSchema });
export const SealSetDefaultSchema = z.object({ private: z.boolean().describe("Whether the caller's new conversations start private.") });

// ---- One conversation's seal ----

// A person, as the seal names them: the address they sign in with, lowercased, and a name when one is known.
export const SealPersonSchema = z.object({
    email: z.string().min(3).max(320),
    name: z.string().max(200).optional(),
});
export type SealPerson = z.infer<typeof SealPersonSchema>;

// Somebody the author let read it for a while (Show for a day): read-only, until `until`.
export const SealGrantSchema = SealPersonSchema.extend({
    until: z.number().describe("Until when they may read it, in milliseconds."),
    by: z.string().describe("Who let them, by address."),
});
export type SealGrant = z.infer<typeof SealGrantSchema>;

// Somebody who asked to read it and has not been answered.
export const SealAskSchema = SealPersonSchema.extend({ at: z.number() });
export type SealAsk = z.infer<typeof SealAskSchema>;

export const SEAL_OPEN_HOURS = 24;
export const SEAL_REASON_MIN = 10;
export const SEAL_REASON_MAX = 500;

// An opening without asking. Kept on the conversation for good; no route removes one. `approvedBy` is the second
// person an organisation's two-person rule asked for; `pending` means that second person has not agreed yet, and nothing
// can be read until they do. `refusedBy` ends a pending one without it ever opening.
export const SealOpenSchema = SealPersonSchema.extend({
    id: z.string().describe("The opening's own id."),
    at: z.number().describe("When it was asked for, in milliseconds."),
    until: z.number().describe("Until when it may be read, in milliseconds. Counted from the second person's yes when one was needed."),
    reason: z.string().min(SEAL_REASON_MIN).max(SEAL_REASON_MAX).describe("Why, in the opener's words, as the author is shown them."),
    approvedBy: SealPersonSchema.extend({ at: z.number() }).optional(),
    refusedBy: SealPersonSchema.extend({ at: z.number() }).optional(),
    pending: z.literal(true).optional(),
});
export type SealOpen = z.infer<typeof SealOpenSchema>;

// How a conversation is sealed, as the registry keeps it. `from` names the conversation a subagent, a review or a fork
// took its seal from: changing that one's seal changes this one's with it, since its words are that one's work in prose.
export const SealSchema = z.object({
    since: z.number().describe("When it was made private, in milliseconds."),
    readers: z.array(SealPersonSchema).max(50).describe("Who reads it besides an opening: its author first, then the people they added."),
    grants: z.array(SealGrantSchema).max(50).optional(),
    asks: z.array(SealAskSchema).max(50).optional(),
    opens: z.array(SealOpenSchema).max(200).optional(),
    from: z.string().optional(),
});
export type Seal = z.infer<typeof SealSchema>;

// How the caller reads it: a reader, someone let in for a while, or an opening without asking. The last two are
// read-only: nothing they press may write into it.
export const SealViaSchema = z.enum(["reader", "grant", "open"]);
export type SealVia = z.infer<typeof SealViaSchema>;

// The seal as one caller is shown it on a conversation's summary. A reader sees all of it. Anyone else sees the summary
// cut to a sealed card (`sealed: true`): whether they already asked, and an opening waiting on a second person when they
// are someone who could be it, or the one who asked for it.
export const SealViewSchema = z.object({
    sealed: z.literal(true).optional().describe("The caller cannot read this conversation: the summary is cut to whose it is, where it stands and its diff."),
    via: SealViaSchema.optional().describe("How the caller reads it. Absent on a sealed card."),
    until: z.number().optional().describe("Until when the caller may read it, for a grant or an opening."),
    readers: z.array(SealPersonSchema).optional(),
    grants: z.array(SealGrantSchema).optional(),
    asks: z.array(SealAskSchema).optional(),
    opens: z.array(SealOpenSchema).optional(),
    asked: z.literal(true).optional().describe("On a sealed card: the caller asked to read it and has not been answered."),
    pending: SealOpenSchema.optional().describe("An opening without asking that waits on a second person, shown to its opener and to whoever could agree."),
    canOpen: z.literal(true).optional().describe("On a sealed card: the caller may open it without asking (the sandbox owner)."),
    canApprove: z.literal(true).optional().describe("The caller may agree to the pending opening, as the second person."),
});
export type SealView = z.infer<typeof SealViewSchema>;
export const SEAL_VIEW_DESCRIPTION =
    "Set on a private conversation: how the caller reads it, or, with `sealed`, that they cannot and this summary is cut to whose it is, where it stands and its diff. Absent on a conversation everyone who sees it may read.";

// ---- Route bodies ----

export const SealIdSchema = z.object({ id: z.string().min(1).describe("The conversation.") });

// Make it private (with who besides its author reads it) or shared again. Only its author, or a reader when nobody
// answers for it, may.
export const SealSetSchema = SealIdSchema.extend({
    private: z.boolean(),
    readers: z.array(z.string().min(3).max(320)).max(49).optional().describe("Who besides its author may read it, by address. Absent keeps the list it has."),
});
export type SealSet = z.infer<typeof SealSetSchema>;

export const SealAnswerSchema = SealIdSchema.extend({
    email: z.string().min(3).max(320).describe("Whose ask this answers."),
    answer: z.enum(["day", "always", "decline"]).describe("Show it to them for a day, add them as a reader, or say no."),
});
export type SealAnswer = z.infer<typeof SealAnswerSchema>;

// What the owner's passkey signs to open a conversation without asking. The challenge is the sha256 of this document's
// text exactly as `SealOpenProof.document` carries it, so the daemon checks the same bytes it parses.
export const SealOpenDocumentSchema = z.strictObject({
    v: z.literal(1),
    purpose: z.literal("intentic-conversation-open"),
    conversationId: z.string().min(1),
    reason: z.string().min(SEAL_REASON_MIN).max(SEAL_REASON_MAX),
    nonce: z.string().min(16).max(64),
    expiresAt: z.number().int().positive(),
});
export type SealOpenDocument = z.infer<typeof SealOpenDocumentSchema>;
export const SEAL_PROOF_MAX_AGE_MS = 5 * 60_000;

export const SealOpenPrepareSchema = SealIdSchema.extend({ reason: z.string().trim().min(SEAL_REASON_MIN).max(SEAL_REASON_MAX) });

// The signed document travels as `SealOpenProofSchema` (seal-proof.ts), apart from this file so the summary schema that
// reads this one does not import the passkey shapes, which sit behind the event frames that import the summary.

// What the editor needs to run the ceremony: the document text to hash, the relying party and the owner's credentials.
export const SealOpenCeremonySchema = z.object({
    document: z.string().min(1).max(4096),
    rpId: z.string().min(1),
    credentials: z.array(z.object({ id: z.string(), transports: z.array(z.string()).optional() })),
});
export type SealOpenCeremony = z.infer<typeof SealOpenCeremonySchema>;

export const SealApproveSchema = SealIdSchema.extend({
    open: z.string().min(1).describe("Which opening."),
    agree: z.boolean(),
});
export type SealApprove = z.infer<typeof SealApproveSchema>;

/** The document's text as it is signed and sent. */
export const sealOpenDocumentText = (document: SealOpenDocument): string => JSON.stringify(document);
