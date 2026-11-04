import type { LinkQuery } from "@intentic/sandbox-contract/app-routes";
import type { LocationQueryValue, RouteLocationRaw } from "vue-router";
import { here, page } from "../../../lib/routes/links";
import type { DeviceCardFix } from "./deviceAttention";

// The Devices view's two addresses. Selection lives in the URL so a machine is deep-linkable and the back
// button works; kept here so the board's cards, the device page's back link and the view's own reader cannot
// disagree about the shape. Each is made in the frame and sandbox the reader is in (lib/routes/links.ts `here`).

/** The fleet board: every machine, nothing selected. */
export const boardRoute = (): RouteLocationRaw => ({ path: here(page.devices()), query: {} });

export const deviceRoute = (key: string): RouteLocationRaw => ({ path: here(page.devices()), query: { device: key } });

// The selected machine's key as the URL carries it. An array is what vue-router hands back for a repeated
// param (`?device=a&device=b`), which names no single machine.
export const selectedKey = (value: LocationQueryValue | LocationQueryValue[] | undefined): string | undefined =>
    typeof value === `string` && value !== `` ? value : undefined;

// A capability's tile by its catalog entry, for every link from this tab. Made from the page's own constructor, whose
// one parameter is the entry: when it was a route param named `card` until 21 Sep, three callers kept passing that,
// which vue-router drops without a word, so "Connect this device" opened the whole catalogue instead of its tile.
export const capabilityRoute = (entry: string, query?: LinkQuery): string => here(page.capabilities(entry, { query }));

// Where a concern's `card` fix leads: the card that ADDS a device, or an existing connection's own form. Kept
// here rather than in each surface that draws a concern, since a fix is an address and addresses live in one file.
export const cardRoute = (fix: DeviceCardFix): string =>
    capabilityRoute(fix.card, fix.connection === undefined ? undefined : { edit: fix.connection });
