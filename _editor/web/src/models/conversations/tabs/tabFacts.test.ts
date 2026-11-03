import "@intentic/testing/dom";
import type { AgentStatus } from "@intentic/sandbox-contract/schemas/agents";
import { NO_ATTENTION } from "../../agent-status/agentStatus-lanes";
import type { AgentStanding } from "../../agent-status/agentStatus-standing";
import { Conversation } from "../session/conversation";
import { runningTurn } from "../../../testing/runningTurn";
import { endingOfTab } from "./tabFacts";

// How a chat's live turn is ending, as the chat draws it (endingOfTab): off the board's card whenever there is one, and
// off it alone for a turn the card says runs while this window follows no stream of it, so a Stop or a dismissal made
// in another window or on the board shows in this chat too.

const card = (status: AgentStatus): AgentStanding => ({ status, attention: NO_ATTENTION });

describe(`a turn this window follows`, () => {
    it(`reads the card's ending, which folds every press into one`, () => {
        const chat = new Conversation(`c1`);
        runningTurn(chat.turn);

        expect(endingOfTab(chat, card(`stopping`))).toBe(`stopping`);
        expect(endingOfTab(chat, card(`dismissing`))).toBe(`dismissing`);
        expect(endingOfTab(chat, card(`running`))).toBeUndefined();
    });

    it(`reads its own press where there is no card`, () => {
        const chat = new Conversation(`c1`);
        runningTurn(chat.turn);
        expect(endingOfTab(chat, undefined)).toBeUndefined();

        chat.turn.endedByReader(`stop`);
        expect(endingOfTab(chat, undefined)).toBe(`stopping`);
    });
});

describe(`a turn only the card says runs`, () => {
    it(`shows a Stop or a dismissal made anywhere, off the card alone`, () => {
        const chat = new Conversation(`c1`);

        expect(endingOfTab(chat, card(`stopping`))).toBe(`stopping`);
        expect(endingOfTab(chat, card(`dismissing`))).toBe(`dismissing`);
    });

    it(`says no ending for a turn nobody ended, nor once the turn is over`, () => {
        const chat = new Conversation(`c1`);
        for (const status of [`running`, `resuming`, `landing`, `idle`, `stopped`, `error`, `awaiting`] as const) {
            expect(endingOfTab(chat, card(status))).toBeUndefined();
        }
    });

    it(`says nothing without a card: this window saw no turn to end`, () => {
        expect(endingOfTab(new Conversation(`c1`), undefined)).toBeUndefined();
    });
});
