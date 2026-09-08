// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reloadOnHotUpdate } from "./hotReload";

// Guards a dev-only singleton against Vite's hot update, which re-executes a changed module and everything up to
// the accepting boundary. `hot.accept` fires only for the boundary, so a singleton sitting under one is silently
// re-evaluated with no callback running (two stores, one window); this pins that second-evaluation case, not the
// accept.

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
    // jsdom refuses a real navigation; the assertion is only that reload was called.
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

    // The boundary case: the file itself was edited.
    it(`reloads when the update is addressed to the module`, () => {
        const { context, accepted } = hotContext();
        reloadOnHotUpdate(meta(`/src/composables/chat/useChat.ts`, context));

        accepted[0]?.();

        expect(reload).toHaveBeenCalledTimes(1);
    });

    // The case this file exists for: a re-executed module gets a `?t=` stamp and no callback. Without this, the
    // window ends up with two store instances, one of them never rendered.
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

    // The record lives on the window, not this module: this module is re-evaluated by the very updates it catches, so
    // a module-level Set would be replaced and remember nothing.
    it(`survives its own module being re-evaluated`, async () => {
        reloadOnHotUpdate(meta(`/src/composables/chat/useChat.ts`, hotContext().context));

        vi.resetModules();
        const { reloadOnHotUpdate: reborn } = await import("./hotReload");
        reborn(meta(`/src/composables/chat/useChat.ts?t=1788553354564`, hotContext().context));

        expect(reload).toHaveBeenCalledTimes(1);
    });
});
