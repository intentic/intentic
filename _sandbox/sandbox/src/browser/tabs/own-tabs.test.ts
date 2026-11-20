import type { BrowserPage, BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import { ownTabsDocument, ownTabsOf } from "./own-tabs.js";

const savedAt = 1_700_000_000_000;

const window = (pages: readonly BrowserPage[]): BrowserSession => ({
    name: "browser-own",
    label: "Your browser",
    server: "_own",
    running: true,
    activityAt: savedAt,
    own: true,
    pages: [...pages],
});

describe("the person's own window, as its restore keeps it", () => {
    test("its tabs in strip order with their names and icons, and which was in front", () => {
        const kept = ownTabsOf(
            window([
                { id: "p1", url: "https://one.test/", title: "One", favicon: "data:image/png;base64,AA==", active: false },
                { id: "p2", url: "https://two.test/", active: true },
                { id: "p3", url: "https://three.test/", title: "Three", active: false },
            ]),
            savedAt,
        );
        expect(kept).toEqual({
            tabs: [
                { url: "https://one.test/", title: "One", favicon: "data:image/png;base64,AA==" },
                { url: "https://two.test/" },
                { url: "https://three.test/", title: "Three" },
            ],
            front: 1,
            savedAt,
        });
    });

    test("a blank new tab is nothing to bring back, and the front is counted among what is kept", () => {
        const kept = ownTabsOf(
            window([
                { id: "p1", url: "about:blank", active: false },
                { id: "p2", url: "https://two.test/", active: false },
                { id: "p3", url: "https://three.test/", active: true },
            ]),
            savedAt,
        );
        expect(kept.tabs.map((tab) => tab.url)).toEqual(["https://two.test/", "https://three.test/"]);
        expect(kept.front).toBe(1);
    });

    test("a blank tab in front leaves the first kept one to stand for it", () => {
        const kept = ownTabsOf(
            window([
                { id: "p1", url: "https://one.test/", active: false },
                { id: "p2", url: "", active: true },
            ]),
            savedAt,
        );
        expect(kept).toEqual({ tabs: [{ url: "https://one.test/" }], front: 0, savedAt });
        expect(ownTabsOf(window([]), savedAt)).toEqual({ tabs: [], front: 0, savedAt });
    });

    test("a window kept open for months reopens no more than fifty", () => {
        const pages = Array.from({ length: 60 }, (_, index) => ({ id: `p${index}`, url: `https://site.test/${index}`, active: index === 59 }));
        const kept = ownTabsOf(window(pages), savedAt);
        expect(kept.tabs).toHaveLength(50);
        expect(kept.front).toBe(0);
    });

    test("the document lives beside the window's profile, which never travels", () => {
        expect(ownTabsDocument).toMatchObject({ root: "workspace", path: ".intentic/local/browser/_own.tabs.json", granularity: "object", history: [] });
        expect(ownTabsDocument.stateFile).toMatchObject({ path: ".intentic/local/browser/", portability: "derived" });
        // A tab's name and icon are its own to have or not: an address alone is a tab to bring back.
        expect(ownTabsDocument.schema.parse({ tabs: [{ url: "https://one.test/" }], front: 0, savedAt })).toEqual({
            tabs: [{ url: "https://one.test/" }],
            front: 0,
            savedAt,
        });
    });
});
