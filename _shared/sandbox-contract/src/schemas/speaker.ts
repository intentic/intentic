import { z } from "zod";
import type { MessageVoice } from "./agent.js";
import type { SessionOwner } from "./agents.js";

// WHO IS SPEAKING, as the sandbox verified it: one typed value every door builds once, from which the older one-line
// facts are derived (the message's `voice`, the turn's `actor` string, the conversation's `owner`), so no reader parses a
// prefix to learn whether a person is at the keyboard. Shared with transcript rows that want to say who spoke. Named apart
// from `Speaker` (agents.ts), which is only which side of a transcript a search snippet came from.

export const TurnSpeakerSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("person"),
        email: z.string().describe("The signed-in member, as the sandbox verified them."),
        name: z.string().optional().describe("Their display name, where the sign-in carries one."),
    }),
    z.object({
        kind: z.literal("program"),
        token: z.string().describe("The label of the control token a person minted and handed to this program."),
    }),
    z.object({
        kind: z.literal("agent"),
        conversationId: z.string().describe("The conversation whose agent is speaking: a child reporting back, a peer's message."),
    }),
    z.object({
        kind: z.literal("sandbox"),
        source: z
            .string()
            .optional()
            .describe("What in the sandbox spoke: an automation, a watch that fired, a job that ended, a repair. Absent when it does not say."),
    }),
]);
export type TurnSpeaker = z.infer<typeof TurnSpeakerSchema>;

// Prefixed so a token labelled like an email, or a conversation id, can never read as a person.
const TOKEN_PREFIX = "token:";
const AGENT_PREFIX = "agent:";

/** The one-line attribution a turn and a queued message carry: a person's email, else the prefixed program or agent. */
export const speakerActor = (speaker: TurnSpeaker): string | undefined => {
    switch (speaker.kind) {
        case "person":
            return speaker.email;
        case "program":
            return `${TOKEN_PREFIX}${speaker.token}`;
        case "agent":
            return `${AGENT_PREFIX}${speaker.conversationId}`;
        case "sandbox":
            return undefined;
    }
};

/** Whose words a message is: a program writes through a person's door, so it speaks with a person's voice. */
export const speakerVoice = (speaker: TurnSpeaker): MessageVoice =>
    speaker.kind === "program" ? "person" : speaker.kind === "agent" ? "agent" : speaker.kind === "sandbox" ? "sandbox" : "person";

/** The member who owns what this speaker opens; a program, an agent and the sandbox own nothing, so theirs stay claimable. */
export const speakerOwner = (speaker: TurnSpeaker): Pick<SessionOwner, "email" | "name"> | undefined => {
    if (speaker.kind !== "person") {
        return undefined;
    }
    const owner: Pick<SessionOwner, "email" | "name"> = { email: speaker.email };
    if (speaker.name !== undefined) {
        owner.name = speaker.name;
    }
    return owner;
};

/** A person, verified, at the keyboard: never a program holding a token a person minted. */
export const spokenByPerson = (speaker: TurnSpeaker | undefined): boolean => speaker?.kind === "person";
