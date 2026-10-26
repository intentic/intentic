import type { ChatMessage } from "./transcript";

// WHO TYPED A PROMPT, for a chat several people speak into. The sandbox names the person on each user row it records
// (TranscriptRow.speaker, as it verified them); the bubble this window draws before that row arrives names nobody, and
// is the signed-in person's own. A program, an agent or the sandbox speaking is not a person and draws no face.

export interface PromptAuthor {
    readonly email: string;
    readonly name?: string;
}

// The signed-in person, or undefined on a loopback daemon with no sign-in.
type Self = PromptAuthor | undefined;

export const promptAuthorOf = (message: ChatMessage, self: Self): PromptAuthor | undefined => {
    if (message.role !== `user`) {
        return undefined;
    }
    const speaker = message.speaker;
    if (speaker?.kind === `person`) {
        return speaker.name === undefined ? { email: speaker.email } : { email: speaker.email, name: speaker.name };
    }
    return speaker === undefined && message.local === true ? self : undefined;
};

// Whether two or more people have typed into this conversation: only then does a face beside a prompt say anything,
// since in a chat of one every prompt is the same person's. Stops at the second person found.
export const severalPeopleIn = (messages: readonly ChatMessage[], self: Self): boolean => {
    let first: string | undefined;
    for (const message of messages) {
        const email = promptAuthorOf(message, self)?.email.toLowerCase();
        if (email === undefined) {
            continue;
        }
        if (first === undefined) {
            first = email;
        } else if (email !== first) {
            return true;
        }
    }
    return false;
};
