import { EventEmitter } from "node:events";
import type { Browser, BrowserContext, Page } from "playwright";
import { unstubbed } from "@intentic/testing";

// The session observer needs page lifecycle signals, without launching Chromium or a display.
export const browserSessionFixture = () => {
    const page = () => {
        const events = new EventEmitter();
        const value: Page = unstubbed<Page>("page", {
            url: () => "about:blank",
            title: async () => "",
            on: (event, listener) => {
                events.on(event, listener);
                return value;
            },
            once: (event, listener) => {
                events.once(event, listener);
                return value;
            },
        });
        return { value, events };
    };
    const first = page();
    const second = page();
    const contextEvents = new EventEmitter();
    const context: BrowserContext = unstubbed<BrowserContext>("context", {
        pages: () => [first.value, second.value],
        on: (event, listener) => {
            contextEvents.on(event, listener);
            return context;
        },
        newCDPSession: async () => {
            throw new Error("no CDP in session fixture");
        },
    });
    const browser: Browser = unstubbed<Browser>("browser", {
        contexts: () => [context],
        on: () => browser,
        close: async () => undefined,
    });
    return { browser, first, second };
};
