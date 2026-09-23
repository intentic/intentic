import "@intentic/testing/dom";
import { STATE_DIR } from "@intentic/constants";
import { resetSandboxScope } from "@intentic/extension-api";
import { IconStub } from "@intentic/ui/testing";
import { type Component, computed, createApp, h, nextTick } from "vue";
import ChatQueue from "../../composer/ChatQueue.vue";
import type { PendingAttachment } from "../../drafts/useChatAttachments";
import { Conversation } from "../../session/conversation";
import type { ChatMessage } from "../../transcript/transcript";
import { runningTurn } from "../../../../testing/runningTurn";
import ChatEditNotice from "./ChatEditNotice.vue";
import { conversationView, PANE_VIEW } from "../useChat-view";

// The words over the composer that read the pane's conversation alone: an armed edit's way out, and the queue's promise.

const CHIP: PendingAttachment = { id: `u1`, name: `shot.png`, path: `${STATE_DIR}/a/shot.png`, status: `done`, progress: 100 };

let unmount: (() => void) | undefined;
const mountOver = (component: Component, chat: Conversation) => {
    const view = conversationView(computed(() => chat));
    const element = document.createElement(`div`);
    const app = createApp({ render: () => h(component) });
    app.provide(PANE_VIEW, view);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    unmount = () => app.unmount();
    return { view, element };
};

afterEach(() => {
    unmount?.();
    unmount = undefined;
    resetSandboxScope();
});

describe(`keeping both instead of editing`, () => {
    it(`forks at the edited prompt and hands the fork the half-written replacement`, async () => {
        const chat = new Conversation(`c1`);
        const rows: ChatMessage[] = [
            { id: 1, role: `user`, text: `first`, rewindIndex: 0 },
            { id: 2, role: `assistant`, text: `done` },
        ];
        chat.transcript.adopt(rows);
        chat.draft.value = `half a thought`;
        chat.transcript.beginEdit(chat.transcript.messages.value[0]!);
        chat.draft.value = `first, better`;
        chat.attachments.value = [CHIP];
        const { view, element } = mountOver(ChatEditNotice, chat);
        const fork = new Conversation(`fork`);
        const forkAt = jest.spyOn(view, `forkAt`).mockReturnValue(fork);
        await nextTick();

        [...element.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Keep both`))?.click();

        expect(forkAt.mock.calls).toEqual([[0, `now`]]);
        expect(fork.draft.value).toBe(`first, better`);
        expect(fork.attachments.value).toEqual([CHIP]);
        // This pane's composer is back to what the pencil displaced.
        expect(chat.transcript.editing.value).toBeUndefined();
        expect(chat.draft.value).toBe(`half a thought`);
    });
});

describe(`the queue`, () => {
    it(`names when what waits goes, by what the turn is doing`, async () => {
        const chat = new Conversation(`c1`);
        chat.queue.value = { items: [{ id: `m1`, text: `and the docs`, voice: `person`, queuedAt: 1, revision: 1 }], revision: 1 };
        const { element } = mountOver(ChatQueue, chat);
        await nextTick();
        expect(element.textContent).toContain(`Goes out as soon as the agent is free`);

        runningTurn(chat.turn);
        await nextTick();
        expect(element.textContent).toContain(`Goes when this turn ends`);

        chat.transcript.adopt([{ id: 1, role: `assistant`, text: ``, permission: { requestId: `p1`, toolName: `Bash`, status: `pending` } }]);
        await nextTick();
        expect(element.textContent).toContain(`Goes in once you answer the request above`);
    });
});
