import { isDeclinedAnswer, isFailureSentence, withoutToolCallStandIns } from "./failure-sentences.js";

/* WHAT A ONE-SHOT REPLY HAS TO BE BEFORE IT COUNTS AS AN ANSWER, stated once, for every helper that goes through
 * the quick model.
 *
 * Each of those helpers takes a model's words and writes them into a durable field: a session title, a commit
 * subject, the sentence on a permission card, a loop's verdict. So each of them owned the same three lines of
 * defence, and each owned them SEPARATELY, which is how the family kept growing on one caller at a time. The
 * naming pass guarded a spent allowance, then an auth failure walked in and took four names. Both were guarded,
 * then a declined answer walked in and took the name AND the commit subject it fed. All three were guarded, then
 * a tool-call stand-in walked in and took four names and three commit subjects (failure-sentences.ts, at
 * TOOL_CALL_STAND_IN, tells that story). Every round, the same fix, copied into one more file.
 *
 * SO THE CONTRACT MOVES TO THE SEAM. A caller no longer asks for TEXT and then decides whether it got an answer,
 * it asks for a VALUE and says what makes one usable; askQuickModel hands back that value or nothing at all.
 * There is no road left where an unchecked reply reaches a field, because there is no road left where a caller
 * receives an unchecked reply.
 *
 * AND AN UNUSABLE REPLY IS A REASON TO ASK THE NEXT MODEL, which is the property the copied guards could never
 * have. Each of them ran after the walk was over: the rung had answered, the chain was finished, and a reply
 * that turned out to be unusable meant the whole helper produced nothing, however many working accounts sat
 * below the one that misbehaved. Checked HERE, inside the walk, a rung that writes a tool call instead of a name
 * is a rung that refused, and the next one down gets asked. This is the shape the reference harnesses landed on
 * too, from different directions: t3code decodes each helper's reply against a schema and treats a decode
 * failure as the provider having failed; OpenClaw passes its own normaliser INTO the generator so a reply that
 * normalises to nothing falls through to the next model; hermes-agent rejects an answer-shaped title outright
 * ("truncating would store half an assistant blob as the session title, which is still an assistant blob")
 * rather than cutting it down, and lets the next turn ask again.
 *
 * WHAT IS NOT HERE: anything about a specific field. A ceiling in words, which cleaner unwraps which packaging,
 * whether a note may be absent, all of that belongs to the caller that knows the field. This file owns the part
 * every caller shares, which is the question itself. */

/* A REPLY THAT IS NOT AN ANSWER, AS OPPOSED TO A RUNG THAT IS DOWN, and the distinction is worth a class because
 * the walk spends real money on it.
 *
 * A refusal is remembered for hours (quick-model.ts REFUSED_FOR_MS): a spent allowance, a revoked token and an
 * outage all outlive the call that discovered them, so the next helper starts below that rung and saves the
 * wait. An unusable ANSWER is the opposite kind of fact. The rung was reachable, its credential was good, it
 * replied in a couple of seconds and the reply was the wrong shape, which is sampling rather than a condition:
 * remembering it would sideline the sandbox's best model for two hours over one bad roll of the dice, and the
 * next walk would pay a worse rung for every helper in the meantime.
 *
 * So this one is thrown, stepped over, reported in the walk's own words, and forgotten. */
export class UnusableAnswerError extends Error {}

/* WHAT ONE HELPER ASKED FOR, in the terms the seam can check it against.
 *
 * `read` is where a caller's existing unwrapper goes (cleanSessionTitle, cleanCommitSubject and friends): the
 * packaging a model reaches for even when told not to is stripped rather than refused, because the answer is
 * right and only its wrapper is wrong. It may return anything the caller wants, which is what lets one reply
 * carry several fields (a commit subject and its release note) without the seam knowing what they are.
 *
 * `unusable` is the judgment: a SENTENCE saying what is wrong with the value, or undefined when nothing is. A
 * sentence rather than a boolean because it is shown to the user, both in the Changes panel's draft report
 * (landed-subject.ts renders every rung's reason) and in the message a fully spent chain throws. */
export interface QuickAnswer<T> {
    // What this helper is asking for, as a noun phrase that reads inside a sentence: `a session title`.
    readonly what: string;
    readonly read: (reply: string) => T;
    readonly unusable: (value: T) => string | undefined;
}

// One prompt and the answer it expects, the pair askQuickModel takes. Together rather than as two parameters
// because a prompt without its contract is exactly the call this file exists to make impossible.
export interface QuickAsk<T> {
    readonly prompt: string;
    readonly answer: QuickAnswer<T>;
}

/* THE VALUE ONE RUNG PRODUCED, or a throw naming what it did instead. Runs inside the walk's try, so both roads
 * out are already handled: a plain Error is a refusal worth remembering, an UnusableAnswerError is one worth
 * stepping over.
 *
 * THE PROVIDER'S OWN PROSE IS CHECKED FIRST, and on the raw reply. Some providers hand a spent allowance or a
 * dead credential to a helper as the reply text rather than as an error (one-shot.ts catches that on the Claude
 * road; the OpenCode road has no equivalent), and that is a lasting condition wearing an answer's clothes: it is
 * re-thrown as an ordinary refusal so the memo picks it up and the chain stops asking a rung that is out. */
export const readQuickAnswer = <T>(answer: QuickAnswer<T>, reply: string): T => {
    if (isFailureSentence(reply.trim())) {
        throw new Error(reply.trim());
    }
    const prose = withoutToolCallStandIns(reply);
    if (prose === ``) {
        // Two ways to arrive at nothing, and they are worth telling apart in the report: a rung that said nothing
        // at all, and one that spent its turn calling a tool it was never given.
        throw new UnusableAnswerError(reply.trim() === `` ? `answered with nothing` : `wrote a tool call instead of ${answer.what}`);
    }
    const value = answer.read(prose);
    const reason = answer.unusable(value);
    if (reason !== undefined) {
        throw new UnusableAnswerError(reason);
    }
    return value;
};

/* WHETHER A STRING IS THE SHORT PROSE A HELPER ASKED FOR, the usability test the text-shaped helpers share:
 * a name, a commit subject, a sentence on a card. Exported on its own because one reply can carry several
 * fields and only one of them is the answer (landed-subject reads a subject plus two optional trailers, and it
 * is the SUBJECT that decides whether the reply was worth anything).
 *
 * THE WORD CEILING IS THE GENERAL FORM OF "THE MODEL ANSWERED THE ASKER INSTEAD OF THE ASK". isDeclinedAnswer
 * catches the polite refusals by their shape (a question, a first-person opener, an apology); a small model can
 * also just... do something else at length, and hermes-agent's port of the same guard says why the length alone
 * is enough of a signal: titling is a few-word task, so a reply of many words is a model that ignored the task,
 * and storing a truncated blob leaves a blob. Every caller here asked for a phrase or a sentence, so every
 * caller can name a ceiling past which the reply is evidently not the thing it asked for. */
export const sentenceReason = (what: string, value: string, maxWords: number): string | undefined => {
    const clean = value.trim();
    if (clean === ``) {
        return `wrote nothing that reads as ${what}`;
    }
    if (isFailureSentence(clean)) {
        return clean;
    }
    if (isDeclinedAnswer(clean)) {
        return `answered the asker instead of writing ${what}`;
    }
    const words = clean.split(/\s+/u).length;
    return words > maxWords ? `wrote ${words} words where ${what} takes at most ${maxWords}` : undefined;
};

// The whole contract for a helper whose answer IS the string it asked for, which is most of them: its unwrapper
// plus the ceiling it reads well under.
export const sentenceAnswer = (what: string, read: (reply: string) => string, maxWords: number): QuickAnswer<string> => ({
    what,
    read,
    unusable: (value) => sentenceReason(what, value, maxWords),
});
