// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { useRailPins } from "./railPins";

/* The reader's overrule of the seat table. Exercised through the composable rather than a helper, for
 * railMemory.test.ts's reason: what is worth pinning here is that a toggle is VISIBLE to the rail immediately
 * (localStorage is not reactive, so this is the part that can silently not work) and that it survives a reload.
 * No sandbox is selected in this environment, so the pins land under the no-sandbox key. */

const KEY = `intentic.railPins.local`;

beforeEach(() => localStorage.clear());

it(`pins and unpins a route, and the ref moves with it`, () => {
    const pins = useRailPins();
    expect(pins.isPinned(`/ext/deployments/production`)).toBe(false);

    pins.toggle(`/ext/deployments/production`);
    // The computed, not just the reader: the rail seats tiles off `pinned`, so a toggle nothing recomputes is a
    // menu row that appears to do nothing until the next reload.
    expect([...pins.pinned.value]).toEqual([`/ext/deployments/production`]);
    expect(pins.isPinned(`/ext/deployments/production`)).toBe(true);

    pins.toggle(`/ext/deployments/production`);
    expect([...pins.pinned.value]).toEqual([]);
});

it(`pins one route of an extension without dragging its siblings on`, () => {
    // Two Komodo connections are two Deployments tiles sharing one view id: the route is the only thing that
    // tells them apart, which is why pins are kept by route.
    const pins = useRailPins();
    pins.toggle(`/ext/deployments/staging`);

    expect(pins.isPinned(`/ext/deployments/staging`)).toBe(true);
    expect(pins.isPinned(`/ext/deployments/production`)).toBe(false);
});

it(`survives a reload, which is the whole reason it is written down`, () => {
    useRailPins().toggle(`/ext/drafts`);
    expect(JSON.parse(localStorage.getItem(KEY) ?? `[]`)).toEqual([`/ext/drafts`]);

    // A second composable instance is what the next page load looks like from here.
    expect(useRailPins().isPinned(`/ext/drafts`)).toBe(true);
});

it(`treats pins it cannot read as no pins, rather than as a broken rail`, () => {
    localStorage.setItem(KEY, `{ not json`);
    expect([...useRailPins().pinned.value]).toEqual([]);

    localStorage.setItem(KEY, JSON.stringify({ drafts: true }));
    expect([...useRailPins().pinned.value]).toEqual([]);
});
