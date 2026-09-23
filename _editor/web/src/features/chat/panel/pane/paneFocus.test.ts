import "@intentic/testing/dom";
import { effectScope, nextTick, ref } from "vue";
import { commandShortcut, registerCommand } from "../../../../shell/commands/useCommands";
import { usePaneFocus } from "./paneFocus";

// Pins which pane takes the keyboard and where the caret lands: only a pane not already focused raises itself, only
// the focused one names the close shortcut, and the caret goes into the focused pane's composer when the shell asks for
// it or the chat connects, and never on a phone or into a pane the reader is not in.

const CLOSE = `Close this pane: the chat stays open`;

const paneOf = (over: { focused?: boolean; connected?: boolean; mobile?: boolean } = {}) => {
    const input = document.createElement(`textarea`);
    document.body.append(input);
    const state = {
        focused: ref(over.focused ?? true),
        composerFocus: ref(0),
        connected: ref(over.connected ?? false),
        mobile: ref(over.mobile ?? false),
        input: ref<HTMLTextAreaElement | null>(input),
        raise: jest.fn(),
        grow: jest.fn(),
    };
    const scope = effectScope();
    const focus = scope.run(() => usePaneFocus({ ...state, focused: () => state.focused.value }))!;
    return { state, focus, input, scope };
};

afterEach(() => {
    document.body.replaceChildren();
});

describe(`the pane the keyboard is in`, () => {
    it(`raises only a pane that does not hold the focus already`, () => {
        const { state, focus } = paneOf({ focused: true });
        focus.takeFocus();
        expect(state.raise).not.toHaveBeenCalled();

        state.focused.value = false;
        focus.takeFocus();
        expect(state.raise).toHaveBeenCalledTimes(1);
    });

    it(`names the close shortcut on the focused pane's button alone`, () => {
        const closing = registerCommand({
            owner: `builtin`,
            command: `chat.closePane`,
            title: `Close pane`,
            keybinding: `Mod+Shift+W`,
            handler: () => {},
        });
        const { state, focus } = paneOf({ focused: true });
        expect(focus.closeHint.value).toBe(`${CLOSE} (${commandShortcut(`chat.closePane`)})`);

        state.focused.value = false;
        expect(focus.closeHint.value).toBe(CLOSE);
        closing.dispose();
    });
});

describe(`the caret`, () => {
    it(`lands at the end of the focused pane's words when the shell asks for it, and nowhere in another pane`, async () => {
        const { state, input } = paneOf({ focused: true });
        input.value = `carry on with the docs`;
        state.composerFocus.value += 1;
        await nextTick();
        await nextTick();

        expect(document.activeElement).toBe(input);
        expect([input.selectionStart, input.selectionEnd]).toEqual([input.value.length, input.value.length]);
        expect(state.grow).toHaveBeenCalledTimes(1);

        const other = paneOf({ focused: false });
        other.state.composerFocus.value += 1;
        await nextTick();
        await nextTick();
        expect(document.activeElement).toBe(input);
        expect(other.state.grow).not.toHaveBeenCalled();
    });

    it(`lands once the chat connects, but not on a phone and not in a pane the reader is not in`, async () => {
        const phone = paneOf({ mobile: true, connected: true });
        await nextTick();
        expect(document.activeElement).not.toBe(phone.input);
        // Sized either way: a restored draft needs its height whether or not the caret goes in.
        expect(phone.state.grow).toHaveBeenCalledTimes(1);

        const aside = paneOf({ focused: false });
        aside.state.connected.value = true;
        await nextTick();
        await nextTick();
        expect(document.activeElement).not.toBe(aside.input);

        const desk = paneOf();
        desk.state.connected.value = true;
        await nextTick();
        await nextTick();
        expect(document.activeElement).toBe(desk.input);
    });
});
