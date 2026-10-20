import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";
import { type IntenticNative, readEmbed } from "./nativeApp";

// Whether this page is the Android app's, and how it speaks to the app. The flag is read once per page, so each case
// below that reads it evaluates the module afresh; `readEmbed` is the rule itself, over a storage the case hands in.

const MODULE = import.meta.resolve(`./nativeApp`);
const load = () => freshImport<typeof import("./nativeApp")>(MODULE, import.meta.url);

/** What this tab's session storage holds, as a record. */
const tabHolds = () =>
    Object.fromEntries(
        Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index) ?? ``).map((key) => [key, sessionStorage.getItem(key)]),
    );

/** The app's object as `addJavascriptInterface` presents it: one method per message, each call recorded. */
const methodsApp = (look?: string) => {
    const calls: unknown[][] = [];
    const native: IntenticNative = {
        open: (path) => void calls.push([`open`, path]),
        signOut: () => void calls.push([`signOut`]),
        setLook: (named) => void calls.push([`setLook`, named]),
        routed: (path, title, canGoBack) => void calls.push([`routed`, path, title, canGoBack]),
    };
    if (look !== undefined) {
        native.look = () => look;
    }
    return { native, calls };
};

beforeEach(() => {
    sessionStorage.clear();
    delete window.intenticNative;
});

describe(`whether this page is the app's`, () => {
    it(`is turned on by the address and kept for the tab, with the look it names`, () => {
        expect(readEmbed(`?embed=native&look=sanctum`)).toBe(true);
        expect(tabHolds()).toEqual({ "intentic.embed": `native`, "intentic.embed.look": `sanctum` });
    });

    // An in-app navigation drops the query, and a reload loads the address the page was left on: the tab remembers.
    it(`stays on for an address that no longer says, in the same tab`, () => {
        sessionStorage.setItem(`intentic.embed`, `native`);
        expect(readEmbed(`?dir=src`)).toBe(true);
        expect(readEmbed(``)).toBe(true);
    });

    it(`is off in a tab that was never told, which is every browser`, () => {
        expect(readEmbed(``)).toBe(false);
        expect(readEmbed(`?look=dark`)).toBe(false);
        expect(tabHolds()).toEqual({});
    });

    it(`is turned off by any other embed, and the tab forgets it and its look`, () => {
        sessionStorage.setItem(`intentic.embed`, `native`);
        sessionStorage.setItem(`intentic.embed.look`, `dark`);
        expect(readEmbed(`?embed=off`)).toBe(false);
        expect(tabHolds()).toEqual({});
    });

    it(`keeps no look it does not know`, () => {
        sessionStorage.setItem(`intentic.embed.look`, `dark`);
        expect(readEmbed(`?embed=native&look=sepia`)).toBe(true);
        expect(tabHolds()).toEqual({ "intentic.embed": `native`, "intentic.embed.look": `dark` });
    });

    it(`is read once per page, from the tab the page was opened in`, async () => {
        sessionStorage.setItem(`intentic.embed`, `native`);
        const { embedded } = await load();
        expect(embedded()).toBe(true);
        sessionStorage.clear();
        expect(embedded()).toBe(true);
    });
});

describe(`the look the app wears`, () => {
    it(`is what the app's object says now, over what the tab kept`, async () => {
        sessionStorage.setItem(`intentic.embed`, `native`);
        sessionStorage.setItem(`intentic.embed.look`, `light`);
        window.intenticNative = methodsApp(`sanctum`).native;
        const { nativeLook } = await load();
        expect(nativeLook()).toBe(`sanctum`);
    });

    it(`is the one the tab kept when the app's object has none, or says a word it does not know`, async () => {
        sessionStorage.setItem(`intentic.embed`, `native`);
        sessionStorage.setItem(`intentic.embed.look`, `dark`);
        window.intenticNative = methodsApp(`blue`).native;
        const { nativeLook } = await load();
        expect(nativeLook()).toBe(`dark`);
    });

    it(`is none outside the app, whatever the tab or an object says`, async () => {
        sessionStorage.setItem(`intentic.embed.look`, `dark`);
        window.intenticNative = methodsApp(`dark`).native;
        const { nativeLook } = await load();
        expect(nativeLook()).toBeUndefined();
    });
});

describe(`telling the app`, () => {
    it(`calls the app's own method where it injected one`, async () => {
        sessionStorage.setItem(`intentic.embed`, `native`);
        const app = methodsApp();
        window.intenticNative = app.native;
        const { tellNative } = await load();

        expect(tellNative({ kind: `open`, path: `/agents/cnv_1` })).toBe(true);
        expect(tellNative({ kind: `signOut` })).toBe(true);
        expect(tellNative({ kind: `setLook`, look: `dark` })).toBe(true);
        expect(tellNative({ kind: `routed`, path: `/settings`, title: `Settings`, canGoBack: false })).toBe(true);
        expect(app.calls).toEqual([[`open`, `/agents/cnv_1`], [`signOut`], [`setLook`, `dark`], [`routed`, `/settings`, `Settings`, false]]);
    });

    // An addJavascriptInterface method refuses a call that is not made on its own object.
    it(`calls each method on the app's object, never detached from it`, async () => {
        sessionStorage.setItem(`intentic.embed`, `native`);
        const opened: string[] = [];
        const native: IntenticNative = {
            open(this: IntenticNative, path: string): void {
                expect(this).toBe(native);
                opened.push(path);
            },
        };
        window.intenticNative = native;
        const { tellNative } = await load();
        tellNative({ kind: `open`, path: `/menu` });
        expect(opened).toEqual([`/menu`]);
    });

    // The object WebViewCompat.addWebMessageListener injects: one postMessage, the message as JSON.
    it(`posts the message as JSON to an app that listens for messages`, async () => {
        sessionStorage.setItem(`intentic.embed`, `native`);
        const posted: string[] = [];
        window.intenticNative = { postMessage: (message) => void posted.push(message) };
        const { tellNative } = await load();

        expect(tellNative({ kind: `open`, path: `/login?returnTo=%2Fsettings` })).toBe(true);
        expect(tellNative({ kind: `signOut` })).toBe(true);
        expect(posted).toEqual([`{"kind":"open","path":"/login?returnTo=%2Fsettings"}`, `{"kind":"signOut"}`]);
    });

    it(`says it could not where the app hears that message neither way, or threw`, async () => {
        sessionStorage.setItem(`intentic.embed`, `native`);
        window.intenticNative = {
            open: () => {
                throw new Error(`not on this build`);
            },
        };
        const { tellNative } = await load();
        expect(tellNative({ kind: `signOut` })).toBe(false);
        expect(tellNative({ kind: `open`, path: `/menu` })).toBe(false);
    });

    it(`tells nobody outside the app, even where a page set an object of that name`, async () => {
        const app = methodsApp();
        window.intenticNative = app.native;
        const { tellNative } = await load();
        expect(tellNative({ kind: `signOut` })).toBe(false);
        expect(app.calls).toEqual([]);
    });
});
