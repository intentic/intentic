import type { LocationQueryRaw, LocationQueryValue, RouteLocationRaw } from "vue-router";
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

// A capability's tile by its catalog entry, for every link from this tab: the route's one param is `entry`. It was
// `card` until 21 Sep, and three callers kept passing that, which vue-router drops without a word, so "Connect this
// device" opened the whole catalogue instead of its tile.
export const capabilityRoute = (entry: string, query?: LocationQueryRaw): RouteLocationRaw => {
    const tile = { name: `capabilities`, params: { entry } };
    return query === undefined ? tile : { ...tile, query };
};

// Where a concern's `card` fix leads: the card that ADDS a device, or an existing connection's own form. Kept
// here rather than in each surface that draws a concern, since a fix is an address and addresses live in one file.
export const cardRoute = (fix: DeviceCardFix): RouteLocationRaw =>
    capabilityRoute(fix.card, fix.connection === undefined ? undefined : { edit: fix.connection });
