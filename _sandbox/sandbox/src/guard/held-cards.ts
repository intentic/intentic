// Cards whose answer the agent has not collected, by the conversation that raised them, so a turn whose agent stops
// calling does not take its card down with it. A gated call may stop waiting for its card before the card is answered
// (guard/held-asks.ts: a device call's short budget, a CLI whose connection went), so an agent that gives up and ends its
// turn would otherwise cancel a card its owner has not even seen. Instead the turn's close
// (agent/run/placement/turn-close.ts) holds the turn open, parked on the card, until it settles. An approval is then
// kept for the same call and the conversation is woken to make it again; a decline with a note wakes it with the note. A
// bare decline, or no answer at all, wakes nobody, as a resumed turn treats a bare deny (turn-resume.ts). What the wake
// says is the card's own: each gate words what to repeat.

import { unlessAborted } from "@intentic/base/async";

export interface HeldOutcome {
    readonly decision: "approved" | "declined" | "unanswered";
    // The owner's own words on a decline, when they gave any.
    readonly feedback?: string;
}

export interface HeldCard {
    // What the wake tells the agent of this card's outcome; undefined wakes nobody for it.
    readonly told: (outcome: HeldOutcome) => string | undefined;
    readonly settled: Promise<HeldOutcome>;
    // Settles the card unanswered now: the turn holding for it was stopped.
    readonly cancel: () => void;
    // Keeps an approval for the same call once more, for the turn the wake starts.
    readonly carry: () => void;
}

export interface HeldCards {
    // Registers a card the agent has not collected yet; the returned release drops this card alone, once collected.
    readonly add: (conversationId: string, card: HeldCard) => () => void;
    readonly open: (conversationId: string) => readonly HeldCard[];
    // Waits for every card still held on the conversation and wakes it with what came of them; a stop cancels them.
    readonly hold: (conversationId: string, signal: AbortSignal | undefined) => Promise<void>;
}

// Hands the conversation the words a settled card left it; never throws, logging what it could not deliver.
export type HeldCardWake = (conversationId: string, prompt: string) => Promise<void>;

const STOPPED = Symbol("stopped");

// A fence longer than any run of backticks in the text, so a command quoting backticks cannot close it early.
const fenced = (text: string): string => {
    const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `${fence}\n${text}\n${fence}`;
};

// The parts of a wake a gate words for itself, read into one sentence shape so every gate's wake reads alike.
export interface WakeWords {
    // Who answers the card; "The owner" unless it is addressed to someone else.
    readonly who?: string;
    // What was asked, as "allowed <doing>" reads it: `running this on "omen"`.
    readonly doing: string;
    // The exact call, quoted in a fence, when there is text worth quoting.
    readonly call?: string;
    // That nothing happened yet: "It has not run yet".
    readonly notYet: string;
    // How to make the same call again.
    readonly again: string;
    // What a decline left undone, as "so <declinedSo>" reads it: "it did not run".
    readonly declinedSo: string;
    // What a decline forbids from here on.
    readonly refrain: string;
}

// What one settled card tells the agent, or undefined where it wakes nobody.
export const wakeWords =
    (words: WakeWords) =>
    (outcome: HeldOutcome): string | undefined => {
        const who = words.who ?? "The owner";
        const quoted = (lead: string): string => (words.call === undefined ? `${lead}.` : `${lead}:\n\n${fenced(words.call)}`);
        if (outcome.decision === "approved") {
            return (
                `${quoted(`${who} allowed ${words.doing} after your turn ended. ${words.notYet}`)}\n\n` +
                `${words.again} The approval is kept for that exact call and used once; anything different is asked about afresh.`
            );
        }
        const note = outcome.feedback?.trim();
        if (outcome.decision === "declined" && note !== undefined && note !== "") {
            return `${quoted(`${who} declined ${words.doing} after your turn ended, so ${words.declinedSo}`)}\n\nTheir note: ${note}\n\n${words.refrain}`;
        }
        return undefined;
    };

export const createHeldCards = (wake: HeldCardWake): HeldCards => {
    const held = new Map<string, Set<HeldCard>>();
    const drop = (conversationId: string, card: HeldCard): void => {
        const cards = held.get(conversationId);
        cards?.delete(card);
        if (cards?.size === 0) {
            held.delete(conversationId);
        }
    };
    const open = (conversationId: string): readonly HeldCard[] => [...(held.get(conversationId) ?? [])];
    return {
        add: (conversationId, card) => {
            held.set(conversationId, (held.get(conversationId) ?? new Set()).add(card));
            return () => drop(conversationId, card);
        },
        open,
        hold: async (conversationId, signal) => {
            const cards = open(conversationId);
            if (cards.length === 0) {
                return;
            }
            const settled = Promise.all(cards.map((card) => card.settled));
            const outcomes = await unlessAborted(settled, signal, STOPPED);
            for (const card of cards) {
                drop(conversationId, card);
            }
            if (outcomes === STOPPED) {
                for (const card of cards) {
                    card.cancel();
                }
                return;
            }
            const told = cards.flatMap((card, index) => {
                const outcome = outcomes[index];
                if (outcome === undefined) {
                    return [];
                }
                const said = card.told(outcome);
                if (said !== undefined && outcome.decision === "approved") {
                    card.carry();
                }
                return said === undefined ? [] : [said];
            });
            if (told.length > 0) {
                await wake(conversationId, `${told.join("\n\n---\n\n")}\n\nThen continue the task.`);
            }
        },
    };
};
