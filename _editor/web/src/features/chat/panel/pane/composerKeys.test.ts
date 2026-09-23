import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { AgentCommand } from "@intentic/sandbox-contract";
import { useT } from "@intentic/ui/i18n";
import { computed, createApp, h, nextTick, ref, shallowRef } from "vue";
import { activeSandboxId } from "../../../sandbox/overview/activeSandbox";
import { inputHistoryFor } from "../../drafts/inputHistory";
import { Conversation } from "../../session/conversation";
import type { ChatMessage } from "../../transcript/transcript";
import { conversationView } from "../useChat-view";
import { type PopoverList, useComposerKeys, useRecallRing } from "./composerKeys";
import { runningTurn } from "../../../../testing/runningTurn";

// Pins who gets each key in the composer (an open list, then recall, then Escape's ladder, then Enter), what a
// keystroke of the user's own ends, and which key the one hint slot teaches at each moment.

const t = useT();
// A recall ring of its own per case: a ring keeps what it recorded for the page's lifetime.
let rings = 0;
const freshRing = (): string => `sb-keys-${(rings += 1)}`;

let unmount: (() => void) | undefined;
const keysOf = () => {
    const chat = new Conversation(`c1`);
    const view = conversationView(computed(() => chat));
    const input = ref<HTMLTextAreaElement | null>(document.body.appendChild(document.createElement(`textarea`)));
    const open = ref<`mention` | `command` | undefined>();
    const command = ref<AgentCommand>();
    const popovers = {
        mentionOpen: computed(() => open.value === `mention`),
        commandOpen: computed(() => open.value === `command`),
        popoverDismissed: ref(false),
        recallInto: jest.fn(),
        caret: ref(0),
        syncCaret: jest.fn(),
        commandRun: computed(() => command.value),
    };
    const list = (): PopoverList => ({ move: jest.fn(), pickActive: jest.fn(() => true) });
    const lists = { mention: ref<PopoverList>(list()), command: ref<PopoverList>(list()) };
    const live = ref(false);
    const spoken = ref<string>();
    const voice = { live: computed(() => live.value), quit: jest.fn(), slotHint: computed(() => spoken.value) };
    const host = {
        view,
        input,
        history: shallowRef(inputHistoryFor(freshRing())),
        popovers,
        lists,
        voice,
        reachable: ref(true),
        mobile: ref(false),
        continueOffer: ref(false),
        grow: jest.fn(),
        submit: jest.fn(),
    };
    let keys: ReturnType<typeof useComposerKeys> | undefined;
    const app = createApp({
        setup: () => {
            keys = useComposerKeys(host);
            return () => h(`div`);
        },
    });
    app.mount(document.createElement(`div`));
    unmount = () => app.unmount();
    // A key as the textarea hears it; returns whether the composer claimed it.
    const press = (key: string, init: KeyboardEventInit = {}): boolean => {
        const event = new KeyboardEvent(`keydown`, { key, cancelable: true, ...init });
        keys!.onKeydown(event);
        return event.defaultPrevented;
    };
    return { chat, host, open, command, live, spoken, press, keys: keys! };
};

afterEach(() => {
    unmount?.();
    unmount = undefined;
    document.body.innerHTML = ``;
    resetSandboxScope();
});

describe(`an open list`, () => {
    it(`owns the arrows, Tab, Enter and Escape`, () => {
        const { host, open, press } = keysOf();
        open.value = `mention`;

        expect(press(`ArrowDown`)).toBe(true);
        expect(press(`ArrowUp`)).toBe(true);
        expect(host.lists.mention.value.move).toHaveBeenCalledTimes(2);
        expect(press(`Tab`)).toBe(true);
        expect(press(`Enter`)).toBe(true);
        expect(host.lists.mention.value.pickActive).toHaveBeenCalledTimes(2);
        expect(press(`Escape`)).toBe(true);
        expect(host.popovers.popoverDismissed.value).toBe(true);
        expect(host.submit).not.toHaveBeenCalled();
    });

    it(`lets Enter through to the composer when no row is active, and never takes Shift+Enter`, () => {
        const { host, open, press } = keysOf();
        open.value = `command`;
        host.lists.command.value = { move: jest.fn(), pickActive: jest.fn(() => false) };

        press(`Enter`);
        expect(host.submit).toHaveBeenCalledTimes(1);

        expect(press(`Enter`, { shiftKey: true })).toBe(false);
        expect(host.submit).toHaveBeenCalledTimes(1);
    });
});

describe(`Enter`, () => {
    it(`sends, with or without Cmd/Ctrl, and breaks the line with Shift`, () => {
        const { host, press } = keysOf();

        expect(press(`Enter`)).toBe(true);
        expect(press(`Enter`, { shiftKey: true, metaKey: true })).toBe(true);
        expect(press(`Enter`, { shiftKey: true })).toBe(false);

        expect(host.submit).toHaveBeenCalledTimes(2);
    });

    it(`never sends mid-composition, or on a phone, where it is the newline`, () => {
        const { host, press } = keysOf();

        press(`Enter`, { isComposing: true });
        host.mobile.value = true;
        press(`Enter`);

        expect(host.submit).not.toHaveBeenCalled();
    });
});

describe(`Escape`, () => {
    it(`catches a live voice first, then abandons an armed edit`, () => {
        const { chat, host, live, press } = keysOf();
        const rows: ChatMessage[] = [{ id: 1, role: `user`, text: `first`, rewindIndex: 0 }];
        chat.transcript.adopt(rows);
        chat.transcript.beginEdit(chat.transcript.messages.value[0]!);
        live.value = true;

        expect(press(`Escape`)).toBe(true);
        expect(host.voice.quit).toHaveBeenCalledTimes(1);
        expect(chat.transcript.editing.value).toMatchObject({ id: 1 });

        live.value = false;
        expect(press(`Escape`)).toBe(true);
        expect(chat.transcript.editing.value).toBeUndefined();
    });

    it(`stops a generating turn, and leaves one parked on a card alone`, () => {
        const { chat, press } = keysOf();
        const stop = jest.spyOn(chat.turn, `stop`).mockReturnValue(undefined);
        runningTurn(chat.turn);

        expect(press(`Escape`)).toBe(true);
        expect(stop).toHaveBeenCalledTimes(1);

        chat.transcript.adopt([{ id: 1, role: `assistant`, text: ``, permission: { requestId: `p1`, toolName: `Bash`, status: `pending` } }]);
        expect(press(`Escape`)).toBe(false);
        expect(stop).toHaveBeenCalledTimes(1);
    });
});

describe(`recall`, () => {
    it(`brings the last sent message back with ArrowUp on an empty box`, () => {
        const { host, press } = keysOf();
        host.history.value.record(`the one before`);

        expect(press(`ArrowUp`)).toBe(true);

        expect(host.popovers.recallInto.mock.calls).toEqual([[`the one before`]]);
    });

    it(`claims nothing while text is selected`, () => {
        const { chat, host, press } = keysOf();
        host.history.value.record(`the one before`);
        chat.draft.value = `half`;
        host.input.value!.value = `half`;
        host.input.value!.setSelectionRange(0, 4);

        expect(press(`ArrowUp`)).toBe(false);
        expect(host.popovers.recallInto).not.toHaveBeenCalled();
    });

    it(`resets both rings when the pane moves to another chat`, async () => {
        const ring = freshRing();
        activeSandboxId.value = ring;
        const chat = shallowRef(new Conversation(`a`));
        const history = inputHistoryFor(ring);
        const reset = jest.spyOn(history, `reset`);
        const app = createApp({
            setup: () => {
                useRecallRing(() => chat.value);
                return () => h(`div`);
            },
        });
        app.mount(document.createElement(`div`));
        unmount = () => app.unmount();

        chat.value = new Conversation(`b`);
        await nextTick();

        expect(reset).toHaveBeenCalledTimes(2);
    });
});

describe(`typing`, () => {
    it(`grows the box, follows the caret, and catches an armed voice send`, () => {
        const { host, keys } = keysOf();

        keys.onInput();

        expect(host.grow).toHaveBeenCalledTimes(1);
        expect(host.popovers.syncCaret).toHaveBeenCalledTimes(1);
        expect(host.voice.quit).toHaveBeenCalledTimes(1);
    });
});

describe(`the hint slot`, () => {
    it(`teaches whichever key matters now, most urgent first`, () => {
        const { chat, host, command, spoken, keys } = keysOf();
        expect(keys.composerHint.value).toBe(t(`chat.chatPane.atForFilesAndSettings`));

        chat.draft.value = `half`;
        expect(keys.composerHint.value).toBe(t(`chat.chatPane.shiftEnterNewLine`));

        chat.draft.value = ``;
        host.history.value.record(`the one before`);
        expect(keys.composerHint.value).toBe(t(`chat.chatPane.upForPreviousMessage`));

        host.continueOffer.value = true;
        expect(keys.composerHint.value).toBe(t(`chat.chatPane.enterToContinue`));

        command.value = { name: `review`, description: `Review the diff.` };
        expect(keys.composerHint.value).toBe(t(`chat.chatPane.enterRunsCommand`, { name: `review` }));

        runningTurn(chat.turn);
        expect(keys.composerHint.value).toBe(t(`chat.chatPane.escToStop`));

        spoken.value = `Sending in a moment, Esc to catch it`;
        expect(keys.composerHint.value).toBe(`Sending in a moment, Esc to catch it`);
    });
});
