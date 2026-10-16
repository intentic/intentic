import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type App, createApp } from "vue";
import { BRING_BACK_CAP, type SandboxChange } from "./bringBack";
import { activeSandboxId } from "../../app/storage/activeSandbox";
import { forgetBringBack, useBringBack, useQuietChecks } from "./useBringBack";

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
    forgetBringBack();
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

// A folder's page holding the window's own checks, ready to be checked or not as `ready` says.
const mountQuietChecks = (ready: () => boolean): void => {
    app = createApp({
        setup: () => {
            useQuietChecks(ready);
            return () => null;
        },
    });
    app.mount(document.createElement(`div`));
};
// The checks among the links the app heard.
const checks = (links: readonly string[]): number => links.filter((link) => new URL(link).searchParams.get(`do`) === `changes`).length;

// Past the time a folder settles on screen before its first check (useBringBack.ts ARRIVAL_SETTLE_MS).
const SETTLED_MS = 2_000;

test("a folder ready to check is checked once it has settled, and coming back to the window within the minute asks nothing more", () => {
    jest.setSystemTime(1_000_000);
    activeSandboxId.value = `folder-a`;
    mountQuietChecks(() => true);
    const beforeSettling = checks(handed());
    jest.advanceTimersByTime(SETTLED_MS);
    const settled = checks(handed());
    window.dispatchEvent(new Event(`focus`));
    const soonAfter = checks(handed());
    expect([beforeSettling, settled, soonAfter]).toEqual([0, 1, 1]);
    activeSandboxId.value = undefined;
});

test("a folder not ready to check (its first copy still under way) is never asked about", () => {
    activeSandboxId.value = `folder-a`;
    mountQuietChecks(() => false);
    jest.advanceTimersByTime(SETTLED_MS);
    window.dispatchEvent(new Event(`focus`));
    expect(checks(handed())).toBe(0);
    activeSandboxId.value = undefined;
});

// The app's answer, as it dispatches one into the window.
const answer = (detail: unknown): void => {
    window.dispatchEvent(new CustomEvent(`intentic:project`, { detail }));
};

test("an answer that lands while the section is off screen is there when it comes back, Undo's restore point with it", () => {
    const first = mountBringBack();
    first.bringBack(CHANGES, new Set(CHANGES.map((change) => change.path)));
    handed();
    app?.unmount();
    app = undefined;

    answer({ kind: `brought-back`, result: { ok: true, point: `p-1`, applied: [{ path: `api/server.ts`, kind: `modified` }] } });

    const again = mountBringBack();
    expect(again.state.value.step).toEqual({ at: `brought`, point: `p-1`, count: 1, skipped: [] });
    again.undo();
    const links = handed();
    expect(new URL(links.at(-1) ?? ``).searchParams.get(`point`)).toBe(`p-1`);
});

// Two checks out at once: the window's own on the folder it left, and the reader's on the one it arrived at.
test("answers go to the folders that asked, in the order they asked", () => {
    jest.setSystemTime(2_000_000);
    activeSandboxId.value = `folder-a`;
    mountQuietChecks(() => true);
    jest.advanceTimersByTime(SETTLED_MS);
    handed();
    activeSandboxId.value = `folder-b`;
    const section = mountBringBack();
    section.check();
    handed();
    answer({ kind: `changes`, result: { ok: true, direction: `to-sandbox`, changes: CHANGES } });
    answer({ kind: `changes`, result: { ok: true, direction: `to-sandbox`, changes: [] } });
    const onB = section.state.value.step;
    activeSandboxId.value = `folder-a`;
    expect([onB, section.state.value.step]).toEqual([
        { at: `checked`, changes: [], truncated: false },
        { at: `checked`, changes: CHANGES, truncated: false },
    ]);
    activeSandboxId.value = undefined;
});

test("an answer belongs to the folder that asked, even once the window has moved to another", () => {
    activeSandboxId.value = `folder-a`;
    const section = mountBringBack();
    section.check();
    handed();
    activeSandboxId.value = `folder-b`;
    answer({ kind: `changes`, result: { ok: true, direction: `to-sandbox`, changes: CHANGES } });
    const onB = section.state.value.step;
    activeSandboxId.value = `folder-a`;
    expect([onB, section.state.value.step.at]).toEqual([{ at: `idle` }, `checked`]);
    activeSandboxId.value = undefined;
});
