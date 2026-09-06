// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reloadOnHotUpdate } from "./hotReload";

/* THE GUARD THAT KEEPS A SINGLETON SINGULAR IN DEV, and the reason it is not `hot.accept` alone.
 *
 * A hot update re-executes the changed module AND everything between it and the boundary that accepts for it.
 * `hot.accept` is called only for the boundary, so a singleton sitting UNDER one — which is where all of these
 * sit, they are what the chat's components import — is re-evaluated with no callback of ours ever running: two
 * channels, two stores, one window. The symptom is a popped-out chat that ignores the board until it is
 * reloaded by hand, so what is pinned here is the second evaluation, not the accept. */

// A module as Vite hands it over: its url, and a hot context if the dev server is there.
const meta = (url: string, hot: ImportMeta["hot"]): ImportMeta => ({ url, hot }) as unknown as ImportMeta;

const hotContext = (): { context: ImportMeta["hot"]; accepted: (() => void)[] } => {
    const accepted: (() => void)[] = [];
    const context = {
        accept: (callback: () => void) => {
            accepted.push(callback);
        },
    } as unknown as ImportMeta["hot"];
    return { context, accepted };
};

let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
    globalThis.intenticSingletonModules = undefined;
    reload = vi.fn();
    // jsdom refuses a real navigation, and the assertion is that this was CALLED.
    Object.defineProperty(window, `location`, { configurable: true, value: { reload } });
});

afterEach(() => {
    globalThis.intenticSingletonModules = undefined;
});

describe(`reloadOnHotUpdate`, () => {
    it(`does nothing at all without a hot context: a production build runs a module once`, () => {
        reloadOnHotUpdate(meta(`/src/composables/chat/useChat.ts`, undefined));

        expect(reload).not.toHaveBeenCalled();
        expect(globalThis.intenticSingletonModules).toBeUndefined();
    });

    it(`registers the accept and stands aside on a module's first evaluation`, () => {
        const { context, accepted } = hotContext();

        reloadOnHotUpdate(meta(`/src/composables/chat/useChat.ts`, context));

        expect(reload).not.toHaveBeenCalled();
        expect(accepted).toHaveLength(1);
    });

    // The boundary case, which is all this used to cover: the file itself was edited.
    it(`reloads when the update is addressed to the module`, () => {
        const { context, accepted } = hotContext();
        reloadOnHotUpdate(meta(`/src/composables/chat/useChat.ts`, context));

        accepted[0]?.();

        expect(reload).toHaveBeenCalledTimes(1);
    });

    /* THE CASE THIS FILE EXISTS FOR. Vite gives a re-executed module a `?t=` stamp and calls nobody: without
     * this the window would carry two copies of the store from here on, and the notes from its other windows
     * would land on the one the panel is not rendering. */
    it(`reloads when the module is re-evaluated on the way to somebody else's boundary`, () => {
        reloadOnHotUpdate(meta(`/src/composables/chat/useChat.ts`, hotContext().context));

        reloadOnHotUpdate(meta(`/src/composables/chat/useChat.ts?t=1788553354564`, hotContext().context));

        expect(reload).toHaveBeenCalledTimes(1);
    });

    it(`tells the singletons apart: one being re-run is not a reason to reload for another`, () => {
        reloadOnHotUpdate(meta(`/src/composables/chat/useChat.ts`, hotContext().context));
        reloadOnHotUpdate(meta(`/src/composables/chat/chatChannel.ts`, hotContext().context));
        reloadOnHotUpdate(meta(`/src/composables/floating.ts`, hotContext().context));

        expect(reload).not.toHaveBeenCalled();

        reloadOnHotUpdate(meta(`/src/composables/floating.ts?t=1788553354564`, hotContext().context));

        expect(reload).toHaveBeenCalledTimes(1);
    });

    /* The record is on the WINDOW, not in this module, because this module is re-evaluated by the very updates
     * it catches: a module-level Set would be replaced along with everything else and would remember nothing. */
    it(`survives its own module being re-evaluated`, async () => {
        reloadOnHotUpdate(meta(`/src/composables/chat/useChat.ts`, hotContext().context));

        vi.resetModules();
        const { reloadOnHotUpdate: reborn } = await import("./hotReload");
        reborn(meta(`/src/composables/chat/useChat.ts?t=1788553354564`, hotContext().context));

        expect(reload).toHaveBeenCalledTimes(1);
    });
});
