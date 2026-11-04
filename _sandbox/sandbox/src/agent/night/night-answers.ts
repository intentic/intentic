import type { AskQuestion } from "@intentic/sandbox-contract/events/requests";
import type { AgentReply } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { nightSavedWords } from "../../sessions/vocabulary/question-answers.js";
import type { NightAnswers, NightCard } from "../../conversations/actor/parked-cards.js";
import type { SandboxSettingsStore } from "../../settings/settings-store.js";
import { peopleAtEditor } from "../../system/presence.js";
import { type NightClock, nightClock, type NightNow } from "./night-hours.js";

/* WHAT A CARD GETS FROM NIGHT HOURS (night-hours.ts says when).

   A question, under `decide`: the option the agent recommends, by the mark the ask tool tells it to give one, else the
   first, which is where it is told to put it. Under `defer`: words telling it the question waits for the morning, as
   the answer to every question on the card, which every runtime hands its agent as it would the owner's own words.
   A plan the agent chose to make: approved under `decide`; under `defer` it waits like the rest of the morning's
   decisions. The answer's `night` mark is what the frozen card and the agent's own reading are drawn from. */

// The ask tool's own convention for the option the agent would choose (ui-server.ts ASK_TOOL_DESCRIPTION, and Claude
// Code's AskUserQuestion it mirrors).
const RECOMMENDED = /\(recommended\)/i;

// What a question with nothing to pick is answered with under `decide`: the agent's own judgement, said as an answer.
export const OWN_JUDGEMENT = "Decide this yourself, as you would recommend it to the owner.";

// The feedback an approved plan carries into the work, as a person's own note on approving would.
const planApproved = (until: string): string =>
    `Approved for the owner by night hours: they are asleep until ${until} and nobody is at the editor. Go ahead with the ` +
    "plan, keep each choice in it easy to undo, and say in your final message that it was approved for them, so they can review it in the morning.";

/** The labels night hours pick for a question: the ones marked recommended, else the first; none for a free-form ask. */
export const recommendedPicks = (question: AskQuestion): string[] => {
    const marked = question.options.filter((option) => RECOMMENDED.test(option.label)).map((option) => option.label);
    const picks = question.multiSelect ? marked : marked.slice(0, 1);
    if (picks.length > 0) {
        return picks;
    }
    const first = question.options[0]?.label;
    return first === undefined ? [] : [first];
};

/** The reply night hours give a card while they are in force; undefined for one they leave for the morning. */
export const nightReply = (requestId: string, card: NightCard, night: NightNow): AgentReply | undefined => {
    const until = night.until;
    if ("plan" in card) {
        return night.questions === "decide"
            ? { kind: "plan", requestId, approve: true, feedback: planApproved(until), night: { outcome: "approved", until } }
            : undefined;
    }
    if (night.questions === "defer") {
        const words = nightSavedWords(until);
        return { kind: "question", requestId, answers: Object.fromEntries(card.questions.map((question) => [question.question, [words]])), night: { outcome: "saved", until } };
    }
    const answers = Object.fromEntries(
        card.questions.map((question) => {
            const picks = recommendedPicks(question);
            return [question.question, picks.length > 0 ? picks : [OWN_JUDGEMENT]];
        }),
    );
    return { kind: "question", requestId, answers, night: { outcome: "picked", until } };
};

// A card still waiting is asked again once a minute: soon enough that a question raised in the last evening minutes is
// answered as the night begins, rarely enough to cost nothing.
const RECHECK_MS = 60_000;

/** The card registry's night answers, read off the clock at each ask. */
const nightAnswers = (clock: NightClock): NightAnswers => ({
    answer: (requestId, card) => {
        const night = clock.now();
        return night === undefined ? undefined : nightReply(requestId, card, night);
    },
    recheckMs: RECHECK_MS,
});

/** The sandbox's own: its settings' night hours, read as they are saved, and presence's people at the editor. */
export const sandboxNightAnswers = (whole: () => { readonly sandboxSettings: Pick<SandboxSettingsStore, "get" | "onSet"> }): NightAnswers =>
    nightAnswers(
        nightClock({
            read: () => whole().sandboxSettings.get(),
            onSet: (listener) => whole().sandboxSettings.onSet(listener),
            atEditor: peopleAtEditor,
        }),
    );
