// Needs jsdom: which answer each button sends, and what its hover says before the press, are what this card decides.
import "@intentic/testing/dom";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { TranscriptFold, userRow } from "@intentic/sandbox-contract/transcript-fold";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h } from "vue";
import type { CardAnswer } from "../../session/cardReplies";
import type { ChatMessage } from "../transcript";
import ChatPermissionCard from "./ChatPermissionCard.vue";

// A card waiting on the owner, as the daemon's own fold draws it from the frame that raised it.
const pendingCard = (over: Partial<Extract<AgentEvent, { kind: `permission` }>> = {}): ChatMessage => {
    const fold = new TranscriptFold([userRow(`go`, 1, [])]);
    const raised: AgentEvent = {
        kind: `permission`,
        requestId: `p1`,
        toolName: `Bash`,
        title: `Run the migration against the shared database?`,
        alwaysLabel: `Don't ask again for Bash`,
        ...over,
    };
    fold.apply(raised);
    const row = fold.rows.find((candidate) => candidate.permission !== undefined);
    if (row === undefined) {
        throw new Error(`the fold drew no permission card`);
    }
    return { ...row, id: 2 };
};

let app: App | undefined;
// Every answer a press sent, in order.
const sent: CardAnswer[] = [];
const mount = (over: Partial<Extract<AgentEvent, { kind: `permission` }>> = {}): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () =>
            h(ChatPermissionCard, {
                message: pendingCard(over),
                settling: false,
                reply: async (answer: CardAnswer) => {
                    sent.push(answer);
                },
            }),
    });
    app.component(`Icon`, IconStub);
    // The hover a button carries, kept on it where a test can read it.
    app.directive(`tooltip`, {
        mounted: (el: HTMLElement, binding: { value?: string }) => {
            if (binding.value !== undefined) {
                el.dataset[`tip`] = binding.value;
            }
        },
    });
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    sent.length = 0;
});

const buttons = (element: HTMLElement): HTMLButtonElement[] => [...element.querySelectorAll(`button`)];
const press = (element: HTMLElement, label: string): void => {
    const button = buttons(element).find((candidate) => candidate.textContent?.trim() === label);
    if (button === undefined) {
        throw new Error(`no "${label}" on the card`);
    }
    button.click();
};

const row = (element: HTMLElement) =>
    buttons(element).map((button) => ({ label: button.textContent?.trim() || button.getAttribute(`aria-label`), tip: button.dataset[`tip`] }));

it(`offers declining this one call beside the No that stops the turn, which says so before the press`, () => {
    expect(row(mount())).toEqual([
        { label: `Allow once`, tip: undefined },
        // The wider yeses (this tool, everything here) fold behind Allow once's caret rather than standing beside it.
        { label: `More ways to allow`, tip: undefined },
        // Its label already says the turn goes on.
        { label: `Skip this, keep going`, tip: undefined },
        { label: `No`, tip: `Stops turn` },
    ]);
});

it(`sends a plain allow-once from the press itself`, () => {
    press(mount(), `Allow once`);

    expect(sent).toEqual([{ kind: `permission`, decision: `once` }]);
});

// A hard rule's card has nothing wider to offer: no always, and no standing yes would answer it.
it(`draws no caret on a card that always asks and can remember nothing`, () => {
    expect(row(mount({ alwaysLabel: undefined, alwaysAsks: true })).map((button) => button.label)).toEqual([
        `Allow once`,
        `Skip this, keep going`,
        `No`,
    ]);
});

// A denial with words is the one afterReply lets go on (cardReplies.test pins that half).
it(`sends the skip as a denial with words for the agent to steer by`, () => {
    press(mount(), `Skip this, keep going`);

    expect(sent).toEqual([
        {
            kind: `permission`,
            decision: `deny`,
            feedback: `The user declined this one call but wants you to keep going. Do not retry it: carry on another way, or without it, and say what you left undone.`,
        },
    ]);
});

it(`still sends No as a bare denial, the one that stops the turn`, () => {
    press(mount(), `No`);

    expect(sent).toEqual([{ kind: `permission`, decision: `deny` }]);
});
