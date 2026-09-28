import { LOOPBACK_CATCH_FEATURE, type LoopbackCatch, type LoopbackCatchEvent } from "@intentic/sandbox-contract/webext";

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
    } catch {
        return false;
    }
};

export async function* catchLoopback(spec: LoopbackCatch, signal: AbortSignal | undefined): AsyncGenerator<LoopbackCatchEvent> {
    if (!(await allowedOn(spec.host))) {
        yield { type: "busy", reason: `this browser is not allowed on ${spec.host}, so it cannot see where the sign-in lands` };
        return;
    }
    const queue: LoopbackCatchEvent[] = [];
    const seen = new Set<string>();
    let wake: (() => void) | undefined;
    let over = false;
    const nudge = (): void => {
        const resume = wake;
        wake = undefined;
        resume?.();
    };
    const end = (): void => {
        over = true;
        nudge();
    };
    const onUpdated = (tabId: number, change: { url?: string; status?: string }, tab: chrome.tabs.Tab): void => {
        const url = change.url ?? tab.url;
        if (url === undefined || !isLanding(spec, url) || seen.has(`${tabId} ${url}`)) {
            return;
        }
        seen.add(`${tabId} ${url}`);
        // Rebuilt on the redirect's own host, as the device agent does, so the sandbox parses the address the provider sent.
        const landed = new URL(url);
        landed.hostname = spec.host;
        queue.push({ type: "landed", url: landed.toString() });
        nudge();
        // The page cannot load; closing it returns the person to where they started the sign-in.
        void chrome.tabs.remove(tabId).catch(() => undefined);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const deadline = setTimeout(end, Math.max(0, spec.expiresAt - Date.now()));
    signal?.addEventListener("abort", end, { once: true });
    try {
        yield { type: "listening" };
        for (;;) {
            const next = queue.shift();
            if (next !== undefined) {
                yield next;
                continue;
            }
            if (over || signal?.aborted === true) {
                break;
            }
            await new Promise<void>((resolve) => (wake = resolve));
        }
    } finally {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", end);
        chrome.tabs.onUpdated.removeListener(onUpdated);
    }
}
