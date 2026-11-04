import type { AgentReaction } from "@intentic/sandbox-contract/schemas/agents";
import { z } from "zod";
import { opt } from "../../opt.js";
import type { DraftsFile } from "./composer-drafts.js";

/* A PERSON'S MARKS ON A CONVERSATION NO TURN HAS STARTED YET, kept in the drafts file beside the words but never in them:
   a draft's words come and go with every keystroke (empty words clear the draft, and an open new chat has none at all),
   and a mark must outlive all of that until the first turn carries it onto the card (`adoptDraftMarks`). In the same
   document rather than one of its own because it is keyed the same way (person, then conversation), private the same way,
   pushed as the same `drafts` domain, and carried with the workspace the same way: one file, one lock, one read for the
   list that returns both. Pure steps over the file; the store in composer-drafts.ts runs them. */

// Who left it is the key the person's marks sit under (what authorization verified), so a mark holds only the rest.
export const StoredMarkSchema = z.object({
    emoji: z.string(),
    // The person's name as their sign-in carried it when they pressed, for the card the first turn moves it onto.
    name: z.string().optional(),
    at: z.number(),
});
export type StoredMark = z.infer<typeof StoredMarkSchema>;

/** What a press did: the marks the conversation now carries for the person, or `full` when a new kind is over the cap. */
export type MarkStep = { readonly file: DraftsFile; readonly marks: readonly StoredMark[]; readonly changed: boolean } | { readonly full: true };

const marksBy = (file: DraftsFile, person: string): Record<string, StoredMark[]> => file.marks?.[person] ?? {};

/** A person's marks on one conversation, in the order they were first pressed. */
export const marksIn = (file: DraftsFile, person: string, conversationId: string): readonly StoredMark[] => marksBy(file, person)[conversationId] ?? [];

// The file with a person's marks on one conversation replaced; an emptied conversation, person or map leaves no key behind.
const withMarks = (file: DraftsFile, person: string, conversationId: string, marks: readonly StoredMark[]): DraftsFile => {
    const { [conversationId]: _replaced, ...otherConversations } = marksBy(file, person);
    const mine = marks.length === 0 ? otherConversations : { ...otherConversations, [conversationId]: [...marks] };
    const { [person]: _was, ...otherPeople } = file.marks ?? {};
    const everyone = Object.keys(mine).length === 0 ? otherPeople : { ...otherPeople, [person]: mine };
    const { marks: _all, ...rest } = file;
    return Object.keys(everyone).length === 0 ? rest : { ...rest, marks: everyone };
};

/**
 * Puts the person's mark on the conversation, or takes it back. `on` states the intent, as `agents.react` does, so a press
 * already where it asks leaves the file as it was. A kind the conversation does not carry yet is refused once it carries
 * `cap` kinds, as the registry caps a card's. Pure.
 */
export const markIn = (
    file: DraftsFile,
    person: string,
    conversationId: string,
    press: { readonly emoji: string; readonly name?: string | undefined; readonly on: boolean },
    at: number,
    cap: number,
): MarkStep => {
    const held = marksIn(file, person, conversationId);
    const has = held.some((mark) => mark.emoji === press.emoji);
    if (has === press.on) {
        return { file, marks: held, changed: false };
    }
    if (press.on && held.length >= cap) {
        return { full: true };
    }
    const marks = press.on ? [...held, { emoji: press.emoji, ...opt("name", press.name), at }] : held.filter((mark) => mark.emoji !== press.emoji);
    return { file: withMarks(file, person, conversationId, marks), marks, changed: true };
};

/** The file without the person's marks on the conversation: the same object when there were none. Pure. */
export const dropMarksIn = (file: DraftsFile, person: string, conversationId: string): DraftsFile =>
    marksIn(file, person, conversationId).length === 0 ? file : withMarks(file, person, conversationId, []);

/** One person's marks as the card's chips: one per emoji, each wearing only that person. */
export const reactionsOf = (person: string, marks: readonly StoredMark[]): AgentReaction[] =>
    marks.map((mark) => ({ emoji: mark.emoji, by: [{ email: person, ...opt("name", mark.name), at: mark.at }] }));

/** Every conversation the person has marked, as chips. */
export const markedBy = (file: DraftsFile, person: string): Record<string, AgentReaction[]> =>
    Object.fromEntries(Object.entries(marksBy(file, person)).map(([conversationId, marks]) => [conversationId, reactionsOf(person, marks)]));
