import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { computed, ref, shallowRef } from "vue";
import { InputHistory } from "../../../drafts/inputHistory";
import { commandResultOf } from "../../../../../models/conversations/commands/commandResult";
import { conversationView } from "../../../../../models/conversations/panel/useChat-view";
import { Conversation } from "../../../../../models/conversations/session/conversation";
import type { ChatMessage } from "../../../../../models/conversations/transcript/transcript";
import { inSetup, provided } from "../../../../../testing/inSetup";
import { COMMAND_EFFECTS, type CommandEffects, useComposerCommands } from "../composerCommands";

// Pins what Send does with a `/` command the composer answers itself: nothing reaches the agent, the box empties into the
// recall ring, and the answer is a control, a setting or a card; anything else goes on to the send it wraps.

const REPLY: ChatMessage = { id: 2, role: `assistant`, text: `Here is the plan.` };

const composerOf = (messages: readonly ChatMessage[] = []) => {
    const chat = new Conversation(`c1`);
    const view = { ...conversationView(computed(() => chat)), messages: computed(() => messages) };
    const effects = {
        startChat: jest.fn<CommandEffects[`startChat`]>(),
        openSettings: jest.fn<CommandEffects[`openSettings`]>(),
        rename: jest.fn<CommandEffects[`rename`]>(),
        copy: jest.fn<CommandEffects[`copy`]>(async () => true),
    };
    const host = { view, modelOpen: ref(false), voiceAgent: ref(false), history: shallowRef<InputHistory | undefined>(new InputHistory(`commands-test`)), grow: jest.fn() };
    const { result: commands, stop } = inSetup(() => useComposerCommands(host), { provides: [provided(COMMAND_EFFECTS, effects)] });
    const press = { submit: jest.fn<(options?: { readonly now?: boolean }) => void>(), label: `Send` };
    const send = commands.intercept(press);
    // Types the draft and presses Send, as Enter or the button would.
    const run = (text: string): void => {
        chat.draft.value = text;
        send.submit();
    };
    return { chat, host, effects, press, send, run, stop, answer: () => commandResultOf(chat).value };
};

afterEach(() => {
    localStorage.clear();
    resetSandboxScope();
});

describe(`a command the composer answers itself`, () => {
    it(`sends nothing, empties the box into the recall ring, and leaves its answer over the composer`, () => {
        const { chat, host, press, run, answer } = composerOf();
        run(`/usage`);
        expect(press.submit).not.toHaveBeenCalled();
        expect(chat.draft.value).toBe(``);
        expect(host.history.value?.recallable).toBe(true);
        expect(host.grow).toHaveBeenCalledTimes(1);
        expect(answer()).toEqual({ kind: `usage`, typed: `usage` });
    });

    it(`echoes the alias it was typed as`, () => {
        const { run, answer } = composerOf();
        run(`/cost`);
        expect(answer()).toEqual({ kind: `usage`, typed: `cost` });
    });

    it(`keeps every other member of the send it wraps`, () => {
        const { send } = composerOf();
        expect(send.label).toBe(`Send`);
    });

    it(`opens the model picker for a bare /model`, () => {
        const { host, run, answer } = composerOf();
        run(`/model`);
        expect(host.modelOpen.value).toBe(true);
        expect(answer()).toBeUndefined();
    });

    it(`opens the picker, and says why, for a /model naming nothing on offer`, () => {
        const { host, run, answer } = composerOf();
        run(`/model no-such-model-anywhere`);
        expect(host.modelOpen.value).toBe(true);
        expect(answer()).toMatchObject({ kind: `note`, tone: `warning`, typed: `model` });
    });

    it(`starts a new chat for /clear and its aliases`, () => {
        const { effects, run } = composerOf();
        run(`/clear`);
        run(`/new`);
        expect(effects.startChat).toHaveBeenCalledTimes(2);
    });

    it(`renames this chat to the words after /rename, and asks for them when there are none`, () => {
        const { chat, effects, run, answer } = composerOf();
        run(`/rename Login bug`);
        expect(effects.rename.mock.calls).toEqual([[chat, `Login bug`]]);
        expect(answer()).toMatchObject({ kind: `note`, typed: `rename` });
        run(`/rename`);
        expect(effects.rename).toHaveBeenCalledTimes(1);
        expect(answer()).toMatchObject({ kind: `note`, tone: `warning` });
    });

    it(`says nothing is running for /stop over an idle chat`, () => {
        const { run, answer } = composerOf();
        run(`/stop`);
        expect(answer()).toMatchObject({ kind: `note`, typed: `stop` });
        expect(answer()).not.toHaveProperty(`tone`);
    });

    it(`copies the agent's last reply, and says so once the clipboard took it`, async () => {
        const { effects, run, answer } = composerOf([{ id: 1, role: `user`, text: `Plan it.` }, REPLY, { id: 3, role: `notice`, text: `Stopped.` }]);
        run(`/copy`);
        expect(effects.copy.mock.calls).toEqual([[`Here is the plan.`]]);
        await Promise.resolve();
        expect(answer()).toMatchObject({ kind: `note`, typed: `copy` });
    });

    it(`sends a /plan task as the next message, in plan mode`, () => {
        const { chat, press, run } = composerOf();
        run(`/plan add a login page`);
        expect(chat.selection.mode.value).toBe(`plan`);
        expect(press.submit).toHaveBeenCalledTimes(1);
        expect(chat.draft.value).toBe(`add a login page`);
    });

    it(`opens the agent settings for /config`, () => {
        const { effects, run } = composerOf();
        run(`/settings`);
        expect(effects.openSettings).toHaveBeenCalledTimes(1);
    });

    it(`keeps the list it was asked against for /help`, () => {
        const { run, answer } = composerOf();
        run(`/help`);
        const shown = answer();
        expect(shown?.kind === `help` ? shown.rows.filter((row) => row.local !== undefined).length : 0).toBe(13);
    });
});

describe(`anything else`, () => {
    it(`goes on to the send, and puts the last answer away`, () => {
        const { chat, press, run, answer } = composerOf();
        run(`/status`);
        expect(answer()?.kind).toBe(`status`);
        run(`/ext/deployments looks broken`);
        expect(press.submit).toHaveBeenCalledTimes(1);
        expect(chat.draft.value).toBe(`/ext/deployments looks broken`);
        expect(answer()).toBeUndefined();
    });

    it(`is a command the agent publishes, which it runs`, () => {
        const { chat, press, run } = composerOf();
        chat.availableCommands.value = [{ name: `todo`, description: `The owner's own todo skill.`, builtin: false }];
        run(`/todo buy milk`);
        expect(press.submit).toHaveBeenCalledTimes(1);
    });

    it(`is words placed as the agent's own, which are text`, () => {
        const { host, press, run } = composerOf();
        host.voiceAgent.value = true;
        run(`/usage`);
        expect(press.submit).toHaveBeenCalledTimes(1);
    });
});
