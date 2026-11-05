import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { IconStub } from "@intentic/ui/testing";
import { computed, createApp, h, nextTick } from "vue";
import { Conversation } from "../../../../models/conversations/session/conversation";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import { conversationView, PANE_VIEW } from "../../../../models/conversations/panel/useChat-view";
import { type WayOut, wayOutOf } from "../../../../models/conversations/endings/wayOut";
import ChatWayOutStrip from "./ChatWayOutStrip.vue";

// The ways out of a wall a press would only hit again, drawn over the composer: what each press does with the
// conversation, never anything that goes by itself.

let unmount: (() => void) | undefined;
// The pane's view is built before the strip mounts, so a fork spied on it is the one the strip presses.
const mountOver = (chat: Conversation, wayOut: WayOut, fork?: Conversation) => {
    const view = conversationView(computed(() => chat));
    const forkAt = jest.spyOn(view, `forkAt`).mockReturnValue(fork);
    const element = document.createElement(`div`);
    const app = createApp({ render: () => h(ChatWayOutStrip, { wayOut }) });
    app.provide(PANE_VIEW, view);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    unmount = () => app.unmount();
    return { forkAt, element };
};
const buttons = (element: HTMLElement): string[] => [...element.querySelectorAll(`button`)].map((button) => button.textContent?.trim() ?? ``);
const press = (element: HTMLElement, label: string): void => {
    [...element.querySelectorAll(`button`)].find((button) => button.textContent?.includes(label))?.click();
};

afterEach(() => {
    unmount?.();
    unmount = undefined;
    resetSandboxScope();
});

describe(`a broken copy of the workspace`, () => {
    const wayOut = wayOutOf({ status: `error`, failureCode: `workspace-broken` })!;

    it(`offers trying again and a new conversation, and says why another try here is no way on`, async () => {
        const chat = new Conversation(`c1`);
        const { element } = mountOver(chat, wayOut);
        await nextTick();
        expect(element.textContent).toContain(`This copy of the workspace can't be set up, so trying again here fails the same way.`);
        expect(buttons(element)).toEqual([`Try again`, `Continue in a new chat`]);
    });

    it(`carries the conversation into a new one above the words nothing answered, on the files it had`, async () => {
        const chat = new Conversation(`c1`);
        chat.isolated.value = true;
        const rows: ChatMessage[] = [
            { id: 1, role: `user`, text: `add retries`, rewindIndex: 0 },
            { id: 2, role: `assistant`, text: `done` },
            { id: 3, role: `user`, text: `now test the timeout`, rewindIndex: 1 },
            { id: 4, role: `notice`, text: `This conversation's copy of the workspace could not be set up.` },
        ];
        chat.transcript.adopt(rows);
        const fork = new Conversation(`fork`);
        const { forkAt, element } = mountOver(chat, wayOut, fork);
        await nextTick();

        press(element, `Continue in a new chat`);

        expect(forkAt.mock.calls).toEqual([[2, `then`]]);
    });
});

describe(`a failure that came back the same three times`, () => {
    const wayOut = wayOutOf({ status: `error`, failureRepeats: 3 })!;

    it(`counts the repeats, offers another model too, and leaves trying the held words again to their own press`, async () => {
        const chat = new Conversation(`c1`);
        chat.queue.value = { items: [{ id: `m1`, text: `regenerate the client`, voice: `person`, queuedAt: 1, revision: 1 }], revision: 1, paused: `refused` };
        const { element } = mountOver(chat, wayOut);
        await nextTick();
        expect(element.textContent).toContain(`Failed the same way 3 times. Nothing ran.`);
        expect(buttons(element)).toEqual([`Try another model`, `Continue in a new chat`]);
    });

    it(`carries the whole conversation once the model answered, in the shared tree, with the held words in the new composer`, async () => {
        const chat = new Conversation(`c1`);
        chat.isolated.value = false;
        chat.transcript.adopt([
            { id: 1, role: `user`, text: `regenerate the client` },
            { id: 2, role: `assistant`, text: `on it` },
            { id: 3, role: `notice`, text: `Claude Code process exited with code 1.` },
        ]);
        chat.queue.value = { items: [{ id: `m1`, text: `and fix the call sites`, voice: `person`, queuedAt: 1, revision: 1 }], revision: 1, paused: `refused` };
        const fork = new Conversation(`fork`);
        const { forkAt, element } = mountOver(chat, wayOut, fork);
        await nextTick();

        press(element, `Continue in a new chat`);

        expect(forkAt.mock.calls).toEqual([[3, `now`]]);
        expect(fork.draft.value).toBe(`and fix the call sites`);
    });
});
