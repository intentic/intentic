// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { useRailPins } from "./railPins";

// Pins the reader's overrule of the seat table: a toggle is visible to the rail immediately (localStorage isn't
// reactive) and survives a reload.

const KEY = `intentic.railPins.local`;

beforeEach(() => localStorage.clear());

it(`pins and unpins a route, and the ref moves with it`, () => {
    const pins = useRailPins();
    expect(pins.isPinned(`/ext/deployments/production`)).toBe(false);

    pins.toggle(`/ext/deployments/production`);
    expect([...pins.pinned.value]).toEqual([`/ext/deployments/production`]);
    expect(pins.isPinned(`/ext/deployments/production`)).toBe(true);

    pins.toggle(`/ext/deployments/production`);
    expect([...pins.pinned.value]).toEqual([]);
});

it(`pins one route of an extension without dragging its siblings on`, () => {
    // Pins are kept by route, not id: two Komodo connections share one view id but differ by route.
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
