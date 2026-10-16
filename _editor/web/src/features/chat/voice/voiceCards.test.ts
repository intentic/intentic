import type { ChatMessage } from "../../../models/conversations/transcript/transcript";
import { type CardWords, finalReplyOf, optionHeard, spokenCardOf } from "./voiceCards";

// Pins a card put to a person out loud and answered out loud: what is said for each kind, and how what they say back
// becomes the card's own answer, or nothing when it cannot be read as one.

const words: CardWords = {
    question: (question, options) => `${question} ${options}?`,
    questions: (count) => `${count} questions on screen.`,
    permission: (action) => `It wants to ${action}. Allow it?`,
    plan: (title) => `Plan: ${title}. Go ahead?`,
    or: `or`,
};

let nextId = 1;
const row = (fields: Partial<ChatMessage> & Pick<ChatMessage, `role`>): ChatMessage => ({ id: nextId++, text: ``, ...fields });

const question = (multiSelect = false): ChatMessage =>
    row({
        role: `assistant`,
        question: {
            requestId: `q-1`,
            status: `pending`,
            questions: [
                {
                    question: `Which store should sessions use`,
                    header: `Store`,
                    multiSelect,
                    options: [
                        { label: `Redis`, description: `fast` },
                        { label: `Postgres`, description: `already there` },
                        { label: `Memory`, description: `simplest` },
                    ],
                },
            ],
        },
    });

describe(`optionHeard`, () => {
    it(`finds a label said outright, whatever the case and accents`, () => {
        expect(optionHeard(`Let's go with postgres, please.`, [`Redis`, `Postgres`])).toBe(1);
        expect(optionHeard(`Pamięć`, [`Dysk`, `Pamięć`])).toBe(1);
    });
    it(`counts "the second one" in the languages there are voices for`, () => {
        expect(optionHeard(`the second one`, [`A`, `B`, `C`])).toBe(1);
        expect(optionHeard(`Trzecia`, [`A`, `B`, `C`])).toBe(2);
        expect(optionHeard(`die erste`, [`A`, `B`])).toBe(0);
    });
    it(`takes a long phrase with a number in it as the person's own words`, () => {
        expect(optionHeard(`two things bother me about this whole idea`, [`A`, `B`])).toBe(-1);
    });
});

describe(`spokenCardOf`, () => {
    it(`says a question with its options, and takes an option or the person's own words as its answer`, () => {
        const card = spokenCardOf([row({ role: `user`, text: `Add sessions` }), question()], words)!;
        expect(card.text).toBe(`Which store should sessions use Redis, Postgres or Memory?`);
        expect(card.answer(`the second one`)).toEqual({ kind: `question`, answers: { "Which store should sessions use": [`Postgres`] } });
        expect(card.answer(`whatever is cheapest to run`)).toEqual({
            kind: `question`,
            answers: { "Which store should sessions use": [`whatever is cheapest to run`] },
        });
    });

    it(`answers a multiple-choice question with what was said, word for word`, () => {
        const card = spokenCardOf([question(true)], words)!;
        expect(card.answer(`Redis and memory`)).toMatchObject({ answers: { "Which store should sessions use": [`Redis and memory`] } });
    });

    it(`asks a permission and reads a yes, an always and a no`, () => {
        const card = spokenCardOf(
            [row({ role: `assistant`, permission: { requestId: `p-1`, status: `pending`, toolName: `Bash`, displayName: `run the tests` } })],
            words,
        )!;
        expect(card.text).toBe(`It wants to run the tests. Allow it?`);
        expect(card.answer(`Yes, go ahead`)).toEqual({ kind: `permission`, decision: `once` });
        expect(card.answer(`Tak, zawsze`)).toEqual({ kind: `permission`, decision: `always` });
        expect(card.answer(`No.`)).toEqual({ kind: `permission`, decision: `deny` });
        expect(card.answer(`what does it do?`)).toBeUndefined();
    });

    it(`puts a plan by its title, and takes anything but a yes as what to change`, () => {
        const card = spokenCardOf([row({ role: `assistant`, plan: { requestId: `pl-1`, status: `pending`, text: `# Move auth to sessions\n\n1. a\n2. b` } })], words)!;
        expect(card.text).toBe(`Plan: Move auth to sessions. Go ahead?`);
        expect(card.answer(`yes`)).toEqual({ kind: `plan`, approve: true });
        expect(card.answer(`keep the cookies as they are`)).toEqual({ kind: `plan`, approve: false, feedback: `keep the cookies as they are` });
    });

    it(`leaves several questions at once to the screen`, () => {
        const many = question();
        const both: ChatMessage = { ...many, question: { ...many.question!, questions: [...many.question!.questions, ...many.question!.questions] } };
        const card = spokenCardOf([both], words)!;
        expect(card.text).toBe(`2 questions on screen.`);
        expect(card.answer(`Redis`)).toBeUndefined();
    });

    it(`finds nothing once the card is answered`, () => {
        const answered = question();
        expect(spokenCardOf([{ ...answered, question: { ...answered.question!, status: `answered` } }], words)).toBeUndefined();
    });
});

describe(`finalReplyOf`, () => {
    it(`is the turn's last words to the person, past any notice after them`, () => {
        const messages = [
            row({ role: `user`, text: `Fix it` }),
            row({ role: `assistant`, text: `Looking.` }),
            row({ role: `assistant`, text: `Fixed, tests pass.` }),
            row({ role: `notice`, text: `Landed.` }),
        ];
        expect(finalReplyOf(messages)).toBe(`Fixed, tests pass.`);
    });
    it(`is nothing when the person spoke last`, () => {
        expect(finalReplyOf([row({ role: `assistant`, text: `Hi` }), row({ role: `user`, text: `Fix it` })])).toBeUndefined();
    });
});
