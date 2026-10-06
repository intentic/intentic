import { watchQueue } from "@intentic/base/async";
import { LOOPBACK_CATCH_FEATURE, LOOPBACK_CATCH_LONGEST_MS, type LoopbackCatch, type LoopbackCatchEvent } from "@intentic/sandbox-contract/webext";

// A sign-in's loopback redirect, caught in this browser (schemas/loopback-catch.ts in the contract): the device agent's
// `catchLoopback`, answered the same way from where the browser is. Nothing listens on the port here; the tab simply
// reaches http://localhost:<port>/…, the page fails to load, and the address it tried is handed back to the sandbox,
// which alone checks it is this sign-in's. The dead-end tab is then closed, returning the person to the tab they came
// from.
//
// Reading a tab's address needs a host permission for it, and this extension holds none it was not given: it catches
// only in a browser whose owner allowed it on http://localhost (the popup's "add a site", like any other), and says it
// can only then (`loopbackFeatures`), so the sandbox never promises a catch this browser cannot make.

// Every port of each loopback name; Chrome's match pattern without a port matches them all.
const LOOPBACK_ORIGINS = { localhost: "http://localhost/*", "127.0.0.1": "http://127.0.0.1/*" } as const;

const allowedOn = async (host: LoopbackCatch["host"]): Promise<boolean> => {
    try {
        return await chrome.permissions.contains({ origins: [LOOPBACK_ORIGINS[host]] });
        // allow(silent-catch): An unavailable browser permission API refuses the catch, never grants it.
    } catch {
        return false;
    }
};

// What `describe` advertises: the catch only where the browser can read a localhost tab's address at all.
export const loopbackFeatures = async (): Promise<string[]> =>
    (await allowedOn("localhost")) || (await allowedOn("127.0.0.1")) ? [LOOPBACK_CATCH_FEATURE] : [];

// Whether a tab's address is this watch's: the scheme, port and path the provider redirects to, on either loopback
// name, since the browser may have been sent to one and the grant is the same.
export const isLanding = (spec: Pick<LoopbackCatch, "port" | "path">, url: string): boolean => {
    try {
        const parsed = new URL(url);
        return (
            parsed.protocol === "http:" &&
            (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
            parsed.port === String(spec.port) &&
            parsed.pathname === spec.path
        );
        // allow(silent-catch): An invalid navigation URL cannot match the watched callback address.
    } catch {
        return false;
    }
};

export async function* catchLoopback(spec: LoopbackCatch, signal: AbortSignal | undefined): AsyncGenerator<LoopbackCatchEvent> {
    if (!(await allowedOn(spec.host))) {
        yield { type: "busy", reason: `this browser is not allowed on ${spec.host}, so it cannot see where the sign-in lands` };
        return;
    }
    // The device agent's queue and deadline, its 30-minute cap included: a forgotten catch never keeps listening to
    // every tab for as long as a sandbox happened to ask.
    const watch = watchQueue<LoopbackCatchEvent>({ signal, until: spec.expiresAt, longestMs: LOOPBACK_CATCH_LONGEST_MS });
    const seen = new Set<string>();
    const onUpdated = (tabId: number, change: { url?: string; status?: string }, tab: chrome.tabs.Tab): void => {
        const url = change.url ?? tab.url;
        if (url === undefined || !isLanding(spec, url) || seen.has(`${tabId} ${url}`)) {
            return;
        }
        seen.add(`${tabId} ${url}`);
        // Rebuilt on the redirect's own host, as the device agent does, so the sandbox parses the address the provider sent.
        const landed = new URL(url);
        landed.hostname = spec.host;
        watch.push({ type: "landed", url: landed.toString() });
        // The page cannot load; closing it returns the person to where they started the sign-in.
        // allow(silent-catch): The callback tab may already be closed; its URL was delivered before this cleanup.
        void chrome.tabs.remove(tabId).catch(() => undefined);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    try {
        yield { type: "listening" };
        yield* watch.drain();
    } finally {
        chrome.tabs.onUpdated.removeListener(onUpdated);
    }
}
