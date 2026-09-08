import { isDeclinedAnswer, isFailureSentence, isSelfIdentityAnswer, withoutToolCallStandIns } from "../providers/failure-sentences.js";

// Shared contract for one-shot reply helpers (titles, commit subjects, permission-card text, verdicts): askRoleModel
// returns a usable value or nothing, never an unchecked reply.

// An unusable answer is not a dead rung: it is sampling noise rather than a lasting condition, so unlike a refusal it
// is never remembered.
export class UnusableAnswerError extends Error {}

// What one helper asks for: `read` unwraps a reply into a value, `unusable` returns a reason shown to the user, or
// undefined when the value is fine.
export interface RoleAnswer<T> {
    // Noun phrase for use inside a sentence, e.g. `a session title`.
    readonly what: string;
    readonly read: (reply: string) => T;
    readonly unusable: (value: T) => string | undefined;
}

// A prompt paired with the answer contract it must satisfy.
export interface RoleAsk<T> {
    readonly prompt: string;
    readonly answer: RoleAnswer<T>;
}

// Checks one rung's raw reply for a failure sentence first, then runs it through the answer contract: a plain Error is
// a refusal, UnusableAnswerError is a bad answer.
export const readRoleAnswer = <T>(answer: RoleAnswer<T>, reply: string): T => {
    if (isFailureSentence(reply.trim())) {
        throw new Error(reply.trim());
    }
    const prose = withoutToolCallStandIns(reply);
    if (prose === ``) {
        // Distinguishes an empty reply from one that only called a tool, for the error message.
        throw new UnusableAnswerError(reply.trim() === `` ? `answered with nothing` : `wrote a tool call instead of ${answer.what}`);
    }
    const value = answer.read(prose);
    const reason = answer.unusable(value);
    if (reason !== undefined) {
        throw new UnusableAnswerError(reason);
    }
    return value;
};

// Usability test shared by phrase/sentence helpers: empty, a failure sentence, a declined or self-identity answer, or
// over maxWords are all unusable.
export const sentenceReason = (what: string, value: string, maxWords: number): string | undefined => {
    const clean = value.trim();
    if (clean === ``) {
        return `wrote nothing that reads as ${what}`;
    }
    if (isFailureSentence(clean)) {
        return clean;
    }
    if (isDeclinedAnswer(clean) || isSelfIdentityAnswer(clean)) {
        return `answered the asker instead of writing ${what}`;
    }
    const words = clean.split(/\s+/u).length;
    return words > maxWords ? `wrote ${words} words where ${what} takes at most ${maxWords}` : undefined;
};

// Contract for a helper whose answer is exactly the string it asked for: an unwrapper plus the word ceiling it must
// read under.
export const sentenceAnswer = (what: string, read: (reply: string) => string, maxWords: number): RoleAnswer<string> => ({
    what,
    read,
    unusable: (value) => sentenceReason(what, value, maxWords),
});
