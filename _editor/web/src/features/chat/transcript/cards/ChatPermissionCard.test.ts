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
const pendingCard = (): ChatMessage => {
    const fold = new TranscriptFold([userRow(`go`, 1, [])]);
    const raised: AgentEvent = {
        kind: `permission`,
        requestId: `p1`,
        toolName: `Bash`,
        title: `Run the migration against the shared database?`,
        alwaysLabel: `Don't ask again for Bash`,
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
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () =>
            h(ChatPermissionCard, {
                message: pendingCard(),
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

it(`offers declining this one call beside the No that stops the turn, each saying so before the press`, () => {
    expect(buttons(mount()).map((button) => ({ label: button.textContent?.trim(), tip: button.dataset[`tip`] }))).toEqual([
        { label: `Allow once`, tip: undefined },
        { label: `Don't ask again for Bash`, tip: undefined },
        { label: `Skip this, keep going`, tip: `Declines only this call: the agent carries on without it` },
        { label: `No`, tip: `Also stops the turn` },
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
