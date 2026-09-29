import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type App, createApp } from "vue";
import { BRING_BACK_CAP, type SandboxChange } from "./bringBack";
import { useBringBack } from "./useBringBack";

// Pins the link a bring-back sends: the changes the review showed and the reader chose, by name, and nothing at all when
// there is nothing to name or more than one link carries.

// Links leave one at a time, a beat apart (desktop.ts `openDesktopLink`), so the clock is faked and walked past the gaps
// before what the app heard is read.
let heard: string[] = [];
const LINK_GAP_WALK_MS = 1_000;
const handed = (): string[] => {
    jest.advanceTimersByTime(LINK_GAP_WALK_MS);
    return [...heard];
};
beforeEach(() => {
    jest.useFakeTimers();
    heard = [];
    Object.defineProperty(document, `readyState`, { configurable: true, get: () => `complete` });
    stubGlobal(`location`, {
        get href(): string {
            return heard.at(-1) ?? ``;
        },
        set href(link: string) {
            heard.push(link);
        },
    });
});

let app: App | undefined;
afterEach(() => {
    jest.advanceTimersByTime(LINK_GAP_WALK_MS);
    jest.useRealTimers();
    app?.unmount();
    app = undefined;
    unstubAllGlobals();
});

const mountBringBack = (): ReturnType<typeof useBringBack> => {
    let bringBack: ReturnType<typeof useBringBack> | undefined;
    app = createApp({
        setup: () => {
            bringBack = useBringBack();
            return () => null;
        },
    });
    app.mount(document.createElement(`div`));
    if (bringBack === undefined) {
        throw new Error(`the section was not set up`);
    }
    return bringBack;
};
// The `paths` a link carries, read back as the app reads them.
const sent = (link: string | undefined): readonly string[] | undefined =>
    link === undefined ? undefined : JSON.parse(new URL(link).searchParams.get(`paths`) ?? `null`);

const CHANGES: SandboxChange[] = [
    { path: `api/server.ts`, kind: `modified` },
    { path: `old.txt`, kind: `deleted` },
];

test("every change the review showed is named on the link, never left for the app to read as everything", () => {
    const { bringBack, state } = mountBringBack();
    bringBack(CHANGES, new Set(CHANGES.map((change) => change.path)));
    const links = handed();
    expect([links.length, sent(links[0]), state.value.step]).toEqual([1, [`api/server.ts`, `old.txt`], { at: `bringing`, count: 2 }]);
});

test("nothing chosen, or more than one link names, sends nothing and leaves the section where it was", () => {
    const { bringBack, state } = mountBringBack();
    const many: SandboxChange[] = Array.from({ length: BRING_BACK_CAP + 1 }, (_, index) => ({ path: `gen/${index}.txt`, kind: `added` }));
    bringBack(CHANGES, new Set());
    bringBack(many, new Set(many.map((change) => change.path)));
    const refused = [handed(), state.value.step];
    // The cap itself still goes.
    bringBack(many, new Set(many.slice(1).map((change) => change.path)));
    const links = handed();
    expect([refused, links.length, sent(links[0])?.length]).toEqual([[[], { at: `idle` }], 1, BRING_BACK_CAP]);
});
