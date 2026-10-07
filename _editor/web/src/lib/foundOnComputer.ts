import { type NativeProvider, nativeProvidersIn } from "@intentic/sandbox-contract";
import type { LocationQuery, LocationQueryValue, RouteLocationRaw } from "vue-router";
import { z } from "zod";
import { modelsPath } from "./routes/modelsPath";

// THE AI TOOLS ALREADY SIGNED IN ON THIS COMPUTER, as the desktop app found them. The app opens setup as
// `/setup?found=claude,codex` (provider ids, comma-separated); a finished setup lands on Sandbox ▸ Models (`?found=…`), where each
// one is a single "Connect" press: the sandbox signs in afresh, and the browser that is already signed in answers it.
// Nothing is copied: a login's refresh token is single-use, so a copy would sign one side out.
//
// The list has to outlive the setup page's own navigations: a signed-out app sends the reader to the browser to sign in
// and comes back at `/`, which the setup gate sends to `/setup` without the query. So the router keeps it in this tab's
// session storage the moment it is seen (noteFound), and the landing takes it back (foundAfterSetup).

export const FOUND_QUERY = `found`;
export const FOUND_KEY = `intentic.foundOnComputer`;

// Long enough for a first install (Docker and the image can take a quarter of an hour), short enough that a list kept
// by an abandoned setup does not steer a later one.
export const FOUND_STALE_MS = 60 * 60_000;

// As kept: the list and when it was seen, which staleness is measured from.
const KeptSchema = z.object({ found: z.array(z.string()), at: z.number() });

// One key of a query as vue-router hands it back: an array for a repeated key, null for a bare `?key`.
type QueryValue = LocationQueryValue | LocationQueryValue[] | undefined;

// This tab's session storage, or undefined where the browser refuses it: nothing is kept then, and the landing falls
// back to whatever the address still says.
const tabStorage = (): Storage | undefined => {
    try {
        return sessionStorage;
    } catch {
        // allow(silent-catch): a browser that refuses storage keeps no list, which only costs the Sandbox ▸ Models landing.
        return undefined;
    }
};

/** Keeps `found` for this tab, `now` being when it was seen. An empty list keeps nothing and drops nothing. */
export const keepFound = (found: readonly NativeProvider[], now: number = Date.now()): void => {
    if (found.length === 0) {
        return;
    }
    try {
        tabStorage()?.setItem(FOUND_KEY, JSON.stringify({ found, at: now }));
    } catch {
        // allow(silent-catch): a full storage keeps nothing, as if the app had found nothing.
    }
};

/** Takes the kept list out of this tab's storage: the fresh one, or empty, a stale one being dropped unread. */
export const takeFound = (now: number = Date.now()): NativeProvider[] => {
    const raw = tabStorage()?.getItem(FOUND_KEY) ?? null;
    tabStorage()?.removeItem(FOUND_KEY);
    if (raw === null) {
        return [];
    }
    try {
        const kept = KeptSchema.safeParse(JSON.parse(raw)).data;
        return kept !== undefined && now - kept.at <= FOUND_STALE_MS ? nativeProvidersIn(kept.found) : [];
    } catch {
        // allow(silent-catch): a kept value that no longer reads names nothing.
        return [];
    }
};

/* THE OFFER, for Connect wherever it is reached from. A folder's own sandbox, made from its desktop window, opens the
   workspace on the folder (`/?sandbox=…&project=…&found=…`) with no setup page in its way, and a reader may first meet
   Connect later, from the chat's "Connect a model". So whatever the desktop app's addresses name is also remembered for
   this browser, a week at most, and Connect offers it whenever its own address names nothing. Only ids are kept, and
   Connect shows only those not connected yet, so a remembered offer goes quiet by itself once taken. */

export const OFFER_KEY = `intentic.foundOnComputer.offer`;
export const OFFER_STALE_MS = 7 * 86_400_000;

const browserStorage = (): Storage | undefined => {
    try {
        return localStorage;
    } catch {
        // allow(silent-catch): a browser that refuses storage remembers no offer, which only costs Connect's found rows.
        return undefined;
    }
};

/** Remembers what the desktop app found, `now` being when it said so. An empty list changes nothing. */
export const rememberOffer = (found: readonly NativeProvider[], now: number = Date.now()): void => {
    if (found.length === 0) {
        return;
    }
    try {
        browserStorage()?.setItem(OFFER_KEY, JSON.stringify({ found, at: now }));
    } catch {
        // allow(silent-catch): a full storage remembers nothing, as if the app had found nothing.
    }
};

/** The remembered offer while it is fresh, else nothing; read, never taken, since Connect may be opened again. */
export const rememberedOffer = (now: number = Date.now()): NativeProvider[] => {
    const raw = browserStorage()?.getItem(OFFER_KEY) ?? null;
    if (raw === null) {
        return [];
    }
    try {
        const kept = KeptSchema.safeParse(JSON.parse(raw)).data;
        return kept !== undefined && now - kept.at <= OFFER_STALE_MS ? nativeProvidersIn(kept.found) : [];
    } catch {
        // allow(silent-catch): a remembered value that no longer reads offers nothing.
        return [];
    }
};

/** What Sandbox ▸ Models offers as found on this computer: what its address names, else the remembered offer. */
export const foundToOffer = (value: QueryValue, now: number = Date.now()): NativeProvider[] => {
    const named = nativeProvidersIn(value);
    return named.length > 0 ? named : rememberedOffer(now);
};

/**
 * The router's half, for every navigation: a `?found=` on the way into setup is kept for the landing, and any address
 * that names one is remembered as the offer. Only setup's is kept for the landing, since Sandbox ▸ Models carries the same
 * query once setup has handed it over, and keeping it again there would steer the next setup this tab runs.
 */
export const noteFound = (to: { readonly path: string; readonly query: LocationQuery }): true => {
    const found = nativeProvidersIn(to.query[FOUND_QUERY]);
    rememberOffer(found);
    if (to.path === `/setup`) {
        keepFound(found);
    }
    return true;
};

/** What setup found, from its address or else from this tab's storage, which is emptied either way. */
export const foundAfterSetup = (value: QueryValue, now: number = Date.now()): NativeProvider[] => {
    const kept = takeFound(now);
    const named = nativeProvidersIn(value);
    return named.length > 0 ? named : kept;
};

/** Where a finished setup opens the workspace: Sandbox ▸ Models with what was found, else `/` as it always has. */
export const landingAfterSetup = (found: readonly NativeProvider[]): RouteLocationRaw =>
    found.length === 0 ? `/` : modelsPath({ [FOUND_QUERY]: found.join(`,`) });

