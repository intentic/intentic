import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { computed, ref, shallowRef } from "vue";
import { providerAccounts } from "../../../../../models/providers/providerAccounts";
import { Conversation } from "../../../../../models/conversations/session/conversation";
import { conversationView } from "../../../../../models/conversations/panel/useChat-view";
import type { SendIntent } from "../../../composer/composerIntent";
import { inputHistoryFor } from "../../../drafts/inputHistory";
import type { ChatAttachment } from "../../../../../models/conversations/transcript/transcript";

// Pins when Cmd/Ctrl+Enter's draft leaves for a new agent, and what it takes with it.

const startAgent = jest.fn((..._args: unknown[]) => `new`);
jest.mock(`../../../../../models/fleet/agentActions`, () => ({ startAgent: (...args: unknown[]) => startAgent(...args) }));

const { useFreshAgentSend } = await import(`../freshAgentSend`);

// Claude connected, so the draft has a model to go with.
const setup = () => {
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `a1`, label: `Claude`, connectedAt: 1 }] };
    const chat = new Conversation(`c1`);
    chat.registered.value = true;
    chat.draft.value = `  do the other thing  `;
    const view = conversationView(computed(() => chat));
    const files: ChatAttachment[] = [];
    const intent = ref<SendIntent>(`idle`);
    const refusal = ref<string>();
    const history = shallowRef(inputHistoryFor(`sb-fresh`));
    const fresh = useFreshAgentSend({ view, staging: { snapshot: () => files }, history, reachable: ref(true), intent, refusal });
    return { chat, view, files, intent, refusal, history, fresh };
};

afterEach(() => {
    startAgent.mockClear();
    resetSandboxScope();
});

describe(`a draft for a new agent`, () => {
    it(`leaves the box with its files for a new agent's first message`, () => {
        const { chat, files, history, fresh } = setup();
        files.push({ name: `a.png`, path: `/tmp/a.png` });

        expect(fresh.start()).toBe(true);

        expect(startAgent).toHaveBeenCalledWith(`do the other thing`, undefined, undefined, { files: [{ name: `a.png`, path: `/tmp/a.png` }] });
        expect(chat.draft.value).toBe(``);
        expect(history.value.recallable).toBe(true);
    });

    it(`is not offered on a chat with nothing sent yet, which already is a new agent`, () => {
        const { chat, fresh } = setup();
        chat.registered.value = false;

        expect(fresh.offered.value).toBe(false);
        expect(fresh.start()).toBe(false);
        expect(startAgent).not.toHaveBeenCalled();
        expect(chat.draft.value).toBe(`  do the other thing  `);
    });

    it(`stays here for words bound to this chat, a refused send or an empty box`, () => {
        const { chat, intent, refusal, fresh } = setup();
        expect(fresh.offered.value).toBe(true);

        for (const bound of [`place`, `edit`, `plan`] as const) {
            intent.value = bound;
            expect(fresh.offered.value).toBe(false);
        }
        intent.value = `steer`;
        expect(fresh.offered.value).toBe(true);

        refusal.value = `Still uploading`;
        expect(fresh.offered.value).toBe(false);
        refusal.value = undefined;

        chat.draft.value = `   `;
        expect(fresh.offered.value).toBe(false);
    });
});
