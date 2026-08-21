// @vitest-environment jsdom
import { expect, it } from "vitest";
import { createApp, h } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
// The import-time globals this graph reads at module scope: environment.ts's window.env and ui's useDevice
// media queries, are in place before this file loads: vitest.setup.ts installs them for the whole package.
import { useChatPopout } from "../chat/useChatPopout";
import { boundCommand, commands, commandShortcut } from "./useCommands";
import { useShellCommands } from "./useShellCommands";

/* MOVING THE CHAT INTO ITS OWN WINDOW: the one command in this set that a user reaches for many times a day,
 * and the one that had neither a chord nor a name anyone could search for: the palette said "Toggle Chat
 * Pop-Out" while the tab strip's menu row said "Move chat into new window", so the words the user actually
 * types ("window", "new window") matched nothing (QuickOpen matches title and id, as substrings).
 *
 * What is pinned here is what makes it findable AND repeatable: one wording, a bare F9 that every surface can
 * then teach, and a title that keeps reading the state: the palette renders `title` inside a computed, so a
 * registration that froze the string would offer "Move Chat into New Window" for a press that docks. */

const mountShell = (): { unmount: () => void } => {
    const app = createApp({
        setup() {
            useShellCommands();
            return () => h(`div`);
        },
    });
    // Only ever used inside handlers (router.push), so an empty memory router is the whole dependency.
    app.use(createRouter({ history: createMemoryHistory(), routes: [] }));
    app.mount(document.createElement(`div`));
    return app;
};

it(`binds the chat pop-out to F9 and names it for the direction the press will take`, () => {
    const app = mountShell();
    const entry = commands.value.find((candidate) => candidate.command === `chat.togglePopout`);

    expect(entry).toBeDefined();
    expect(entry!.title).toBe(`Move Chat into New Window`);
    // The same words the strip's menu row and the button's tooltip use, and the chord all three now teach.
    expect(commandShortcut(`chat.togglePopout`)).toBe(`F9`);

    useChatPopout().poppedOut.value = true;
    expect(entry!.title).toBe(`Dock Chat Back`);

    useChatPopout().poppedOut.value = false;
    app.unmount();
});

it(`leaves F9 to whatever is running in a terminal`, () => {
    const app = mountShell();

    // A bare function key is the cheapest chord there is, which is why it can't be taken globally: inside the
    // terminal panel F9 belongs to the program on the other end (mc's menu, an editor's key). The gate returns
    // the keystroke to it: the button and the palette are the way out from there.
    const terminal = document.createElement(`div`);
    terminal.className = `term`;
    const inTerminal = terminal.appendChild(document.createElement(`textarea`));
    const chatPanel = document.createElement(`div`);
    chatPanel.className = `chat-panel`;
    const inChat = chatPanel.appendChild(document.createElement(`textarea`));

    // Asserted through the dispatcher rather than against the gate directly: what matters is which command a
    // real F9 resolves to, and the condition only means anything against the context one keydown builds.
    const from = (target: Element): KeyboardEvent => {
        const event = new KeyboardEvent(`keydown`, { key: `F9`, code: `F9` });
        Object.defineProperty(event, `target`, { value: target });
        return event;
    };
    expect(boundCommand(from(inTerminal), false)).toBeUndefined();
    expect(boundCommand(from(inChat), false)?.command).toBe(`chat.togglePopout`);

    app.unmount();
});
