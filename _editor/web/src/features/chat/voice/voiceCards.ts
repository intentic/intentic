import { planParts } from "@intentic/sandbox-contract";
import type { CardAnswer } from "../session/cardReplies";
import type { ChatMessage } from "../transcript/transcript";

// A card the agent is waiting on, said out loud and answered out loud, for a person talking to it hands-free: the
// question with its options, the tool it wants, the plan it made. What they say next is read as the answer where it can
// be (an option named or counted, a yes or a no) rather than queued as a message behind a card nobody answered. Pure:
// the words come in from the caller's language table, the answer goes out as the card's own reply.

/** The words a card is said with, in the reader's language (i18n `chat.voiceCards`). */
export interface CardWords {
    readonly question: (question: string, options: string) => string;
    readonly questions: (count: number) => string;
    readonly permission: (action: string) => string;
    readonly plan: (title: string) => string;
    readonly or: string;
}

export interface SpokenCard {
    readonly requestId: string;
    readonly kind: `question` | `permission` | `plan`;
    /** What is said to put the card to the person. */
    readonly text: string;
    /** The card's reply for what they said back; undefined when it cannot be read as one (a mumble to a yes-or-no). */
    readonly answer: (heard: string) => CardAnswer | undefined;
}

// Lowercased, accents and punctuation gone, one space between words: how a heard phrase and a label are compared.
const plain = (text: string): string =>
    text
        .normalize(`NFD`)
        .replaceAll(/\p{Diacritic}/gu, ``)
        .toLowerCase()
        .replaceAll(/[^\p{L}\p{N}\s]/gu, ` `)
        .replaceAll(/\s+/gu, ` `)
        .trim();

// The answers that open with a yes or a no, in the languages there are voices for. Matched on the phrase's first words,
// already plain.
const YES = /^(yes|yeah|yep|sure|ok|okay|allow|approve|go ahead|do it|tak|jasne|dobrze|zgoda|pewnie|ok|ja|jawohl|si|claro|oui|d accord|sim|va bene|certo)\b/u;
const NO = /^(no|nope|deny|dont|do not|stop|cancel|nie|nein|non|nao|niet)\b/u;
const ALWAYS = /\b(always|every time|zawsze|immer|siempre|toujours|sempre)\b/u;

// Counting words, for "the second one": the index each names.
const ORDINALS: readonly RegExp[] = [
    /\b(first|one|1|pierwsz\w*|jeden|jedna|erste\w*|eins|primer\w*|uno|premier\w*|primeir\w*|prim\w*)\b/u,
    /\b(second|two|2|drug\w*|dwa|dwie|zweite\w*|zwei|segund\w*|dos|deuxieme|deux|second\w*|due)\b/u,
    /\b(third|three|3|trzeci\w*|trzy|dritte\w*|drei|tercer\w*|tres|troisieme|trois|terz\w*|tre)\b/u,
    /\b(fourth|four|4|czwart\w*|cztery|vierte\w*|vier|cuart\w*|cuatro|quatrieme|quatre|quart\w*|quattro)\b/u,
];

/** Which offered label the phrase names: said outright, or counted ("the second one"); -1 for none. */
export const optionHeard = (heard: string, labels: readonly string[]): number => {
    const said = plain(heard);
    if (said === ``) {
        return -1;
    }
    // Whole words only: a label "C" is not said by saying "second".
    const padded = ` ${said} `;
    const named = labels.map(plain).findIndex((label) => label !== `` && (padded.includes(` ${label} `) || (said.length >= 4 && label.includes(said))));
    if (named !== -1) {
        return named;
    }
    // Only a short phrase counts: "the second one" picks; "two things bother me about this" is the person's own words.
    if (said.split(` `).length > 4) {
        return -1;
    }
    // The highest first, since "the second one" also holds a "one".
    for (let index = Math.min(labels.length, ORDINALS.length) - 1; index >= 0; index -= 1) {
        if (ORDINALS[index]!.test(said)) {
            return index;
        }
    }
    return -1;
};

const listed = (labels: readonly string[], or: string): string =>
    labels.length <= 1 ? (labels[0] ?? ``) : `${labels.slice(0, -1).join(`, `)} ${or} ${labels.at(-1)}`;

const spokenQuestion = (message: ChatMessage, words: CardWords): SpokenCard | undefined => {
    const asked = message.question;
    if (asked?.status !== `pending`) {
        return undefined;
    }
    const only = asked.questions.length === 1 ? asked.questions[0] : undefined;
    if (only === undefined) {
        // Several questions at once are a form: said as one, and left for the screen.
        return { requestId: asked.requestId, kind: `question`, text: words.questions(asked.questions.length), answer: () => undefined };
    }
    const labels = only.options.map((option) => option.label);
    return {
        requestId: asked.requestId,
        kind: `question`,
        text: words.question(only.question, listed(labels, words.or)),
        // A phrase that names no option is the person's own answer, which every question takes.
        answer: (heard) => {
            const index = optionHeard(heard, labels);
            const picked = index === -1 || only.multiSelect ? heard.trim() : labels[index]!;
            return picked === `` ? undefined : { kind: `question`, answers: { [only.question]: [picked] } };
        },
    };
};

const spokenPermission = (message: ChatMessage, words: CardWords): SpokenCard | undefined => {
    const asked = message.permission;
    if (asked?.status !== `pending`) {
        return undefined;
    }
    return {
        requestId: asked.requestId,
        kind: `permission`,
        text: words.permission(asked.title ?? asked.displayName ?? asked.toolName),
        answer: (heard) => {
            const said = plain(heard);
            if (YES.test(said)) {
                return { kind: `permission`, decision: ALWAYS.test(said) ? `always` : `once` };
            }
            return NO.test(said) ? { kind: `permission`, decision: `deny` } : undefined;
        },
    };
};

const spokenPlan = (message: ChatMessage, words: CardWords): SpokenCard | undefined => {
    const asked = message.plan;
    if (asked?.status !== `pending`) {
        return undefined;
    }
    return {
        requestId: asked.requestId,
        kind: `plan`,
        text: words.plan(planParts(asked.text).title ?? ``),
        // Anything but a yes is what to change, which a plan takes as the reason it was not approved.
        answer: (heard) => {
            const said = plain(heard);
            if (said === ``) {
                return undefined;
            }
            return YES.test(said) && !NO.test(said)
                ? { kind: `plan`, approve: true }
                : { kind: `plan`, approve: false, feedback: heard.trim() };
        },
    };
};

/** The newest card still waiting that can be put to a person by voice, or undefined. */
export const spokenCardOf = (messages: readonly ChatMessage[], words: CardWords): SpokenCard | undefined => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        const card = spokenQuestion(message, words) ?? spokenPermission(message, words) ?? spokenPlan(message, words);
        if (card !== undefined) {
            return card;
        }
    }
    return undefined;
};

/** The reply a finished turn ends with: its last words to the person, which is what a spoken answer is made from. */
export const finalReplyOf = (messages: readonly ChatMessage[]): string | undefined => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        if (message.role === `user`) {
            return undefined;
        }
        if (message.role === `assistant` && message.text.trim() !== ``) {
            return message.text;
        }
    }
    return undefined;
};
