import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { installI18n } from "@intentic/ui/i18n";
import { IconStub } from "@intentic/ui/testing";
import { computed, createApp, h, nextTick } from "vue";
import { conversationView, PANE_VIEW } from "../../../../../models/conversations/panel/useChat-view";
import { Conversation } from "../../../../../models/conversations/session/conversation";
import ChatBranchDraft from "../ChatBranchDraft.vue";

// The strip over a draft started from a branch: which branch, that its work is committed there, and the way back.

let unmount: (() => void) | undefined;
const mountOver = (chat: Conversation): HTMLElement => {
    const element = document.createElement(`div`);
    const app = createApp({ render: () => h(ChatBranchDraft) });
    app.provide(PANE_VIEW, conversationView(computed(() => chat)));
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    installI18n(app);
    app.mount(element);
    unmount = () => app.unmount();
    return element;
};

afterEach(() => {
    unmount?.();
    unmount = undefined;
    resetSandboxScope();
});

it(`names the branch and where its work goes, and unlinks back to the main line`, async () => {
    const chat = new Conversation(`c1`);
    chat.pendingFromBranch.value = { repo: `apps/web`, branch: `feature/login` };
    const element = mountOver(chat);
    await nextTick();

    expect(element.textContent).toContain(`apps/web · feature/login`);
    expect(element.textContent).toContain(`its work is committed onto that branch`);
    element.querySelector<HTMLButtonElement>(`button[aria-label="Unlink"]`)?.click();
    await nextTick();

    expect(chat.pendingFromBranch.value).toBeUndefined();
    expect(element.querySelector(`[data-branch-draft]`)).toBeNull();
});

it(`says nothing on a draft that starts from the main line`, async () => {
    const element = mountOver(new Conversation(`c1`));
    await nextTick();

    expect(element.querySelector(`[data-branch-draft]`)).toBeNull();
});
