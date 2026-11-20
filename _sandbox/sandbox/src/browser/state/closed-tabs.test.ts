import { CLOSED_LISTED, type ClosedTab, type ClosingTab, type ClosingWindow, listClosed, noteClosed, rememberClosed, takeClosed, worthReopening } from "./closed-tabs.js";

const closedAt = 1_700_000_000_000;

const tab = (url: string, index = 0): Omit<ClosedTab, "id"> => ({ url, title: `title of ${url}`, index, closedAt });

// The parts of a window and its tabs the closed list reads, as plain values: the rest of the record is never touched.
const window = (
    pages: readonly ClosingTab[],
    finishedAt?: number,
): ClosingWindow => ({
    pages: new Map(pages.map((page) => [page.id, page])),
    finishedAt,
});
const page = (id: string, url: string, extra: Partial<ClosingTab> = {}): ClosingTab => ({ id, url, title: undefined, closed: false, ...extra });

describe("a window's closed tabs, for Reopen closed tab", () => {
    test("newest first, each with an id of its own, the oldest falling off past what is kept", () => {
        let closed: readonly ClosedTab[] | undefined;
        for (let index = 0; index < 30; index++) {
            closed = rememberClosed(closed, tab(`https://site.test/${index}`, index));
        }
        expect(closed).toHaveLength(25);
        expect(closed?.[0]).toMatchObject({ url: "https://site.test/29", index: 29 });
        expect(closed?.at(-1)?.url).toBe("https://site.test/5");
        expect(new Set(closed?.map((entry) => entry.id)).size).toBe(25);
    });

    test("taking one brings back the newest, or the one named, and leaves the rest in order", () => {
        const closed = rememberClosed(rememberClosed(rememberClosed(undefined, tab("https://a.test/")), tab("https://b.test/")), tab("https://c.test/"));
        const newest = takeClosed(closed, undefined);
        expect(newest?.tab.url).toBe("https://c.test/");
        expect(newest?.rest.map((entry) => entry.url)).toEqual(["https://b.test/", "https://a.test/"]);
        const named = takeClosed(closed, closed[2]?.id);
        expect(named?.tab.url).toBe("https://a.test/");
        expect(named?.rest.map((entry) => entry.url)).toEqual(["https://c.test/", "https://b.test/"]);
        expect(takeClosed(closed, "c-nobody")).toBeUndefined();
        expect(takeClosed(undefined, undefined)).toBeUndefined();
        expect(takeClosed([], undefined)).toBeUndefined();
    });

    test("the window's state lists the newest ten, without the place each had", () => {
        let closed: readonly ClosedTab[] | undefined;
        for (let index = 0; index < 12; index++) {
            closed = rememberClosed(closed, { url: `https://site.test/${index}`, index, closedAt });
        }
        const listed = listClosed(closed);
        expect(listed).toHaveLength(CLOSED_LISTED);
        expect(listed?.[0]).toEqual({ id: expect.any(String), url: "https://site.test/11", closedAt });
        expect(listClosed([])).toBeUndefined();
        expect(listClosed(undefined)).toBeUndefined();
    });

    test("a tab that went nowhere is nothing to bring back", () => {
        expect(worthReopening("about:blank")).toBe(false);
        expect(worthReopening("")).toBe(false);
        expect(worthReopening("chrome://newtab/")).toBe(false);
        expect(worthReopening("https://site.test/")).toBe(true);
    });

    test("a closing tab is kept with its place among the open tabs, and a restored one by where it was", () => {
        const pages = [
            page("p1", "https://one.test/"),
            page("p2", "https://gone.test/", { closed: true }),
            page("p3", "about:blank", { deferred: { url: "https://three.test/", title: "Three", favicon: "data:image/png;base64,AA==" } }),
        ];
        const record = window(pages);
        noteClosed(record, pages[2] ?? page("p0", ""));
        expect(record.closed).toEqual([
            { id: expect.any(String), url: "https://three.test/", title: "Three", favicon: "data:image/png;base64,AA==", index: 1, closedAt: expect.any(Number) },
        ]);
        noteClosed(record, page("p4", "about:blank"));
        expect(record.closed).toHaveLength(1);
    });

    test("a window that is itself going keeps none of the tabs it takes with it", () => {
        const pages = [page("p1", "https://one.test/")];
        const record = window(pages, closedAt);
        noteClosed(record, pages[0] ?? page("p0", ""));
        expect(record.closed).toBeUndefined();
    });
});
