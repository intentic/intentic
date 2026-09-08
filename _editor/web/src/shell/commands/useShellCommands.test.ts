// @vitest-environment jsdom
import { expect, it } from "vitest";
import { createApp, h } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
// vitest.setup.ts installs window.env and ui's useDevice media queries at module scope before this file loads.
import { receiveFloatingNote } from "../window/floating";
import { boundCommand, commands, commandShortcut } from "./useCommands";
import { useShellCommands } from "./useShellCommands";

// Pins the chat pop-out command: one findable wording across the palette and menu, a shared F9 chord, and a title
// that re-renders live rather than freezing at registration.

const mountShell = (): { unmount: () => void } => {
    const app = createApp({
        setup() {
            useShellCommands();
            return () => h(`div`);
        },
    });
    // Only used inside handlers (router.push), so an empty memory router covers the whole dependency.
    app.use(createRouter({ history: createMemoryHistory(), routes: [] }));
    app.mount(document.createElement(`div`));
    return app;
};

it(`binds the chat pop-out to F9 and names it for the direction the press will take`, () => {
    const app = mountShell();
    const entry = commands.value.find((candidate) => candidate.command === `chat.toggleFloating`);

    expect(entry).toMatchObject({ command: `chat.toggleFloating` });
    expect(commandShortcut(`chat.toggleFloating`)).toBe(`F9`);

    const titleWhenLocal = entry!.title;
    // Announces another window holds the chat; that's what makes it read as floating from this window's side.
    receiveFloatingNote({ kind: `here`, panel: `chat`, id: `other-window`, since: 1 });
    expect(entry!.title).not.toBe(titleWhenLocal);

    receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `other-window` });
    expect(entry!.title).toBe(titleWhenLocal);
    app.unmount();
});

it(`leaves F9 to whatever is running in a terminal`, () => {
    const app = mountShell();

    // F9 stays reachable via the button and palette when a terminal claims the key itself.
    const terminal = document.createElement(`div`);
    terminal.className = `term`;
    const inTerminal = terminal.appendChild(document.createElement(`textarea`));
    const chatPanel = document.createElement(`div`);
    chatPanel.className = `chat-panel`;
    const inChat = chatPanel.appendChild(document.createElement(`textarea`));

    // Goes through boundCommand, not the gate directly: the condition only means something against a real keydown's
    // context.
    const from = (target: Element): KeyboardEvent => {
        const event = new KeyboardEvent(`keydown`, { key: `F9`, code: `F9` });
        Object.defineProperty(event, `target`, { value: target });
        return event;
    };
    expect(boundCommand(from(inTerminal), false)).toBeUndefined();
    expect(boundCommand(from(inChat), false)?.command).toBe(`chat.toggleFloating`);

    app.unmount();
});
