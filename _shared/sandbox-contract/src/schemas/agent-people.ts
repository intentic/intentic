import { z } from "zod";
import { starterLook } from "../models/agent-starter.js";

// THE PEOPLE ON A CONVERSATION'S CARD: who answers for it, and who marked it. Their own module so agents.ts, the fleet's
// summary, stays within its size; agents.ts re-exports every name, so importers keep reading them from there.

// One person behind one mark. The instant rides along so the group can be ordered by who was first, which is also the
// order the names read in.
export const ReactorSchema = z.object({
    email: z.string().describe("Who it was, as the sandbox verified them."),
    name: z.string().optional().describe("What to call them, when their sign-in carried a name. Absent leaves the address to stand for them."),
    at: z.number().describe("When they marked it, in milliseconds."),
});
export type Reactor = z.infer<typeof ReactorSchema>;
// The member answerable for a conversation: whose questions its cards are, who a reviewer asks about its work. Derived
// once from the starter, moved only by `agents.assign`; never a program, which is what `startedBy` is for.
export const SessionOwnerSchema = z.object({
    email: z.string().describe("Who answers for this conversation, as the sandbox verified them."),
    name: z
        .string()
        .optional()
        .describe("What to call them, when the sign-in that made them its owner carried a name. Absent leaves the address to stand for them."),
    since: z.number().describe("When they became its owner, in milliseconds."),
});
export type SessionOwner = z.infer<typeof SessionOwnerSchema>;
// Grouped by emoji on the wire, not as a flat list of presses: every surface draws one chip per emoji, and grouping
// here is what stops three of them each grouping it differently.
export const AgentReactionSchema = z.object({
    emoji: z.string().describe("The mark itself, one emoji, carried as the character rather than as a name that would need a table on both sides."),
    by: z
        .array(ReactorSchema)
        .min(1)
        .describe(
            "Everyone wearing this mark, oldest first, each by name. Carried whole rather than as a count, because a chip reading 3 that cannot say whose is a number nobody can answer. Never empty: the last person taking theirs back takes the whole chip with it.",
        ),
});
export type AgentReaction = z.infer<typeof AgentReactionSchema>;

// WHO HEARS A CONVERSATION'S NEWS (the rule below reads both lists): the people who took part, and each
// person's own answer to how much of it they want. Only the people who took part hear it by default, not everyone
// sharing the sandbox.
export const PARTICIPATIONS = ["prompt", "answer", "land", "mention"] as const;
export const ParticipationSchema = z.enum(PARTICIPATIONS);
export type Participation = z.infer<typeof ParticipationSchema>;
export const ParticipantSchema = z.object({
    email: z.string().describe("Who took part, lowercased, as the sandbox verified them (or as a prompt named them)."),
    name: z.string().optional().describe("What to call them, when their sign-in carried a name."),
    since: z.number().describe("When they first took part, in milliseconds."),
    via: ParticipationSchema.describe(
        "How they first took part: they sent it a message, answered one of its cards, asked to land it, or a message named them with @ and their address.",
    ),
});
export type Participant = z.infer<typeof ParticipantSchema>;

// How much of one conversation's news reaches one person's devices, tab and sounds. `all`: every turn it finishes and
// every card it waits on; `asks`: only when it waits on them; `none`: nothing.
export const NOTIFY_LEVELS = ["all", "asks", "none"] as const;
export const NotifyLevelSchema = z.enum(NOTIFY_LEVELS);
export type NotifyLevel = z.infer<typeof NotifyLevelSchema>;
export const NotifyChoiceSchema = z.object({
    email: z.string().describe("Whose answer it is, lowercased."),
    level: NotifyLevelSchema.describe("What they asked to hear of this conversation."),
    at: z.number().describe("When they chose it, in milliseconds."),
});
export type NotifyChoice = z.infer<typeof NotifyChoiceSchema>;
export const AgentNotifySchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    level: NotifyLevelSchema.nullable().describe(
        "What you want to hear of it: `all` (every finished turn and every card), `asks` (only cards waiting on you), `none` (nothing). Null clears your answer and goes back to the default: `all` if you took part in it, else nothing.",
    ),
});
export type AgentNotify = z.infer<typeof AgentNotifySchema>;

// WHO A CONVERSATION'S NEWS IS FOR, decided once for the daemon's pushes (push/audience.ts) and the editor's chime, tab
// and badge (browserTab.ts), so a phone and a tab never disagree about whether something was yours to hear.
// The people who took part hear it: whoever answers for it, whoever started it, and everyone who sent it a message,
// answered its cards, asked to land it or was named in one of its messages. Each person can say how much of it they
// want: everything, only what waits on them, or nothing. Anyone else hears nothing unless they asked to follow it.
// Whether they may see the conversation at all is a separate check, made where the roster is known (push.ts).

// What happened: a turn it finished, or a card it waits on a person to answer.
export type ConversationNews = "finished" | "asks";

// The facts on a conversation's summary and record this reads; both shapes carry them under these names.
export interface AudienceFacts {
    readonly owner?: { readonly email: string } | undefined;
    readonly startedBy?: string | undefined;
    readonly participants?: readonly Pick<Participant, "email">[] | undefined;
    readonly notify?: readonly Pick<NotifyChoice, "email" | "level">[] | undefined;
}

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

// A person's address, not a program's token label or a parent conversation (agent-starter.ts).
const personStarter = (startedBy: string | undefined): string | undefined =>
    startedBy !== undefined && startedBy.includes("@") && starterLook(startedBy) === undefined ? startedBy : undefined;

/** Whether this person took part in the conversation: answers for it, started it, or is among its participants. */
export const tookPart = (facts: AudienceFacts, email: string): boolean =>
    (facts.owner !== undefined && same(facts.owner.email, email)) ||
    (personStarter(facts.startedBy) !== undefined && same(facts.startedBy ?? "", email)) ||
    (facts.participants?.some((person) => same(person.email, email)) ?? false);

/** How much of this conversation reaches this person: their own answer, else everything if they took part, else nothing. */
export const notifyLevelOf = (facts: AudienceFacts, email: string): NotifyLevel =>
    facts.notify?.find((choice) => same(choice.email, email))?.level ?? (tookPart(facts, email) ? "all" : "none");

/** Whether this news of the conversation is for this person. */
export const hears = (facts: AudienceFacts, email: string, news: ConversationNews): boolean => {
    const level = notifyLevelOf(facts, email);
    return level === "all" || (level === "asks" && news === "asks");
};

/** The facts the rule reads, off a stored conversation record (the daemon's registry entry). */
export const recordFacts = (record: { readonly identity: { readonly startedBy?: string | undefined }; readonly social: Omit<AudienceFacts, "startedBy"> }): AudienceFacts => ({
    owner: record.social.owner,
    startedBy: record.identity.startedBy,
    participants: record.social.participants,
    notify: record.social.notify,
});

/** Everyone this news is for, lowercased, each once, in the order they came to it. */
export const audienceOf = (facts: AudienceFacts, news: ConversationNews): string[] => {
    const candidates = [
        facts.owner?.email,
        personStarter(facts.startedBy),
        ...(facts.participants ?? []).map((person) => person.email),
        ...(facts.notify ?? []).map((choice) => choice.email),
    ].flatMap((email) => (email === undefined ? [] : [email.toLowerCase()]));
    return [...new Set(candidates)].filter((email) => hears(facts, email, news));
};
