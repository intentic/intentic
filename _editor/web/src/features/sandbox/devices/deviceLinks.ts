import type { LocationQueryValue, RouteLocationRaw } from "vue-router";
import type { DeviceCardFix } from "./health/deviceAttention";

// The Devices tab's two addresses. Selection lives in the URL so a machine is deep-linkable and the back
// button works; kept here so the board's cards, the device page's back link and the tab's own reader cannot
// disagree about the shape.

const TAB = { name: `sandbox`, params: { tab: `devices` } } as const;

/** The fleet board: every machine, nothing selected. */
export const boardRoute = (): RouteLocationRaw => ({ ...TAB, query: {} });

export const deviceRoute = (key: string): RouteLocationRaw => ({ ...TAB, query: { device: key } });

// The selected machine's key as the URL carries it. An array is what vue-router hands back for a repeated
// param (`?device=a&device=b`), which names no single machine.
export const selectedKey = (value: LocationQueryValue | LocationQueryValue[] | undefined): string | undefined =>
    typeof value === `string` && value !== `` ? value : undefined;

// Where a concern's `card` fix leads: the card that ADDS a device, or an existing connection's own form. Kept
// here rather than in each surface that draws a concern, since a fix is an address and addresses live in one file.
export const cardRoute = (fix: DeviceCardFix): RouteLocationRaw => {
    const card = { name: `capabilities`, params: { card: fix.card } };
    return fix.connection === undefined ? card : { ...card, query: { edit: fix.connection } };
};
