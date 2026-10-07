// jsdom: the list is kept in this tab's session storage between setup's navigations.
import "@intentic/testing/dom";
import {
    FOUND_KEY,
    FOUND_STALE_MS,
    foundAfterSetup,
    foundToOffer,
    keepFound,
    landingAfterSetup,
    noteFound,
    OFFER_KEY,
    OFFER_STALE_MS,
    rememberedOffer,
    rememberOffer,
    takeFound,
} from "./foundOnComputer";

/* `?found=`: the AI tools the desktop app found signed in on this computer, carried from setup to Sandbox ▸ Models. */

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
});

test("a finished setup lands on Sandbox ▸ Models with what was found, and on / with nothing", () => {
    expect(landingAfterSetup([`claude`, `codex`])).toEqual({ path: `/sandbox/models`, query: { found: `claude,codex` } });
    expect(landingAfterSetup([])).toBe(`/`);
});

test("the list survives the sign-in detour: kept on the way into setup, taken once at the landing", () => {
    noteFound({ path: `/setup`, query: { found: `claude,codex`, project: `My App` } });
    // Back from the browser's sign-in at `/setup` with no query: the kept list answers.
    expect(foundAfterSetup(undefined)).toEqual([`claude`, `codex`]);
    // Taken, not read: the next setup in this tab is not steered by it.
    expect(foundAfterSetup(undefined)).toEqual([]);
    expect(sessionStorage.getItem(FOUND_KEY)).toBeNull();
});

test("the address wins over the kept list, and the kept one is dropped either way", () => {
    keepFound([`gemini`]);
    expect(foundAfterSetup(`cursor`)).toEqual([`cursor`]);
    expect(sessionStorage.getItem(FOUND_KEY)).toBeNull();
});

test("only setup's address is kept: Sandbox ▸ Models carries the same query once setup handed it over", () => {
    noteFound({ path: `/sandbox/models`, query: { found: `claude` } });
    expect(sessionStorage.getItem(FOUND_KEY)).toBeNull();
    // A setup visit with nothing found keeps nothing, and leaves what was kept alone.
    keepFound([`codex`]);
    noteFound({ path: `/setup`, query: {} });
    expect(takeFound()).toEqual([`codex`]);
});

test("a list kept longer than a setup takes is dropped unread", () => {
    keepFound([`claude`], 1_000);
    expect(takeFound(1_000 + FOUND_STALE_MS)).toEqual([`claude`]);
    keepFound([`claude`], 1_000);
    expect(takeFound(1_000 + FOUND_STALE_MS + 1)).toEqual([]);
    sessionStorage.setItem(FOUND_KEY, `not json`);
    expect(takeFound()).toEqual([]);
});

test("any address the desktop app opens with a found list is remembered as Connect's offer, a folder's own sandbox's too", () => {
    noteFound({ path: `/`, query: { sandbox: `sbx_1`, project: `api`, found: `claude,codex` } });
    // Not the setup landing's: a later setup in this tab is not steered by it.
    expect(sessionStorage.getItem(FOUND_KEY)).toBeNull();
    // Read, never taken: Connect may be opened again from the chat.
    expect(foundToOffer(undefined)).toEqual([`claude`, `codex`]);
    expect(foundToOffer(undefined)).toEqual([`claude`, `codex`]);
    // Connect's own address wins, and an address naming nothing leaves the offer alone.
    expect(foundToOffer(`gemini`)).toEqual([`gemini`]);
    noteFound({ path: `/sandbox/models`, query: {} });
    expect(rememberedOffer()).toEqual([`claude`, `codex`]);
});

test("a remembered offer lasts a week, and one that no longer reads offers nothing", () => {
    rememberOffer([`claude`], 1_000);
    expect(rememberedOffer(1_000 + OFFER_STALE_MS)).toEqual([`claude`]);
    expect(rememberedOffer(1_000 + OFFER_STALE_MS + 1)).toEqual([]);
    localStorage.setItem(OFFER_KEY, `{"found":"claude"}`);
    expect(rememberedOffer()).toEqual([]);
    localStorage.setItem(OFFER_KEY, `not json`);
    expect(rememberedOffer()).toEqual([]);
});
