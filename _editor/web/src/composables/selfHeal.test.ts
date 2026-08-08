// @vitest-environment jsdom
//
// The last-line recovery: a crash inside the startup window reads as poisoned local state, so the app wipes
// what this origin stored and reloads itself once — the mechanised version of the "clear site data" advice
// that used to be the fix. These tests pin the once-ness (a crash that survives the clean slate must surface,
// not loop) and the split across the reload (this page only MARKS the database wipe; the next boot performs
// it before anything holds a connection open).
import { beforeAll, beforeEach, expect, it, vi } from "vitest";

// jsdom's window.location is unforgeable (see staleChunk.test.ts) — the reload is observed through a replaced
// global, resolved from the global scope at call time.
const reload = vi.fn();

beforeAll(() => {
    Object.defineProperty(globalThis, `location`, { configurable: true, value: { reload } });
});

beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    reload.mockClear();
});

// Fresh module per test: the startup clock and the in-flight guard are module state.
const load = async (): Promise<typeof import("./selfHeal")> => {
    vi.resetModules();
    return await import("./selfHeal");
};

it(`answers a startup crash by wiping storage, marking the try, and reloading`, async () => {
    const { reportStartupError } = await load();
    localStorage.setItem(`intentic.workspaceTabs.sbx-1`, `poisoned`);
    reportStartupError(new Error(`boom`));
    expect(localStorage.getItem(`intentic.workspaceTabs.sbx-1`)).toBeNull();
    expect(localStorage.getItem(`intentic.wipeOnBoot`)).toBe(`1`);
    expect(sessionStorage.getItem(`intentic.selfHealed`)).toBe(`1`);
    expect(reload).toHaveBeenCalledOnce();
});

it(`does not wipe twice: a crash that survives the clean slate surfaces instead of looping`, async () => {
    const { reportStartupError } = await load();
    reportStartupError(new Error(`boom`));
    reload.mockClear();
    // The reload happened; this is the next page's startup, still carrying the sessionStorage marker.
    const { reportStartupError: reportAgain } = await load();
    localStorage.setItem(`user-preference`, `kept`);
    reportAgain(new Error(`still boom`));
    expect(localStorage.getItem(`user-preference`)).toBe(`kept`);
    expect(reload).not.toHaveBeenCalled();
});

it(`leaves an error outside the startup window alone — that is a bug, not poisoned storage`, async () => {
    vi.spyOn(performance, `now`).mockReturnValue(0);
    const { reportStartupError } = await load();
    vi.spyOn(performance, `now`).mockReturnValue(60_000);
    localStorage.setItem(`user-preference`, `kept`);
    reportStartupError(new Error(`boom`));
    expect(localStorage.getItem(`user-preference`)).toBe(`kept`);
    expect(reload).not.toHaveBeenCalled();
});

it(`the marked boot deletes every database this origin holds, then retires the mark`, async () => {
    const deleted: string[] = [];
    vi.stubGlobal(`indexedDB`, {
        databases: () => Promise.resolve([{ name: `keyval-store` }, { name: `intentic.chat` }]),
        deleteDatabase: (name: string) => {
            deleted.push(name);
            const request = { onsuccess: undefined as (() => void) | undefined, onblocked: undefined, addEventListener: () => {} };
            queueMicrotask(() => request.onsuccess?.());
            return request;
        },
    });
    const { purgeIfMarked } = await load();
    localStorage.setItem(`intentic.wipeOnBoot`, `1`);
    await purgeIfMarked();
    expect(deleted.toSorted()).toEqual([`intentic.chat`, `keyval-store`]);
    expect(localStorage.getItem(`intentic.wipeOnBoot`)).toBeNull();
});

it(`an unmarked boot touches no database`, async () => {
    const deleteDatabase = vi.fn();
    vi.stubGlobal(`indexedDB`, { databases: () => Promise.resolve([]), deleteDatabase });
    const { purgeIfMarked } = await load();
    await purgeIfMarked();
    expect(deleteDatabase).not.toHaveBeenCalled();
});
