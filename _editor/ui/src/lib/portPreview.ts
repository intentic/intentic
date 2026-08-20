/* WAITING FOR A PREVIEW ADDRESS TO COME UP, and opening a forwarded port in a tab.
 *
 * A sandbox port is previewed at a port-<slot>-<sandboxId>.<zone> hostname minted by the daemon's preview proxy.
 * A slot's FIRST forward mints DNS, so the address exists before it resolves, and the two ways of showing it
 * both fail badly if handed the address too early: an iframe that error-pages never retries, and a tab
 * navigated to an unresolvable host shows the browser's own "site can't be reached" with nothing to retry from.
 *
 * `no-cors` IS THE PROBE. It resolves on ANY HTTP response — 200, 404, 500, a redirect, an opaque response with
 * nothing readable in it, and rejects only on DNS or socket failure. That is exactly the question being asked
 * ("does this name resolve to something listening yet?") and no narrower request can ask it cross-origin.
 *
 * Three surfaces had each written this loop: the preview panel's iframe gate, the terminal's Ctrl+click on a
 * localhost link, and the Ports view's Preview button. The last of those is an extension, which could reach
 * neither of the first two, so the loop, the intervals, and the sentence a user reads while waiting all lived
 * in triplicate, with the two tab-opening copies identical down to their wording. */

// Fixed rather than per-caller: how long a freshly-minted DNS record takes to propagate is a property of the
// preview proxy, not of the button that is waiting on it, and three surfaces disagreeing about it was the bug.
const PROBE_INTERVAL_MS = 3000;
const PROBE_SLOW_AFTER_MS = 30_000;
// Generous, because a first start can legitimately spend a minute on propagation, but bounded, so a host that
// will never resolve is not polled for the life of the tab.
const PROBE_GIVE_UP_MS = 180_000;

export type ProbeOutcome = "reachable" | "gaveUp" | "abandoned";

export interface ProbeOptions {
    /* Called after each failed attempt with how long the wait has run. A caller that narrates progress uses the
     * `slow` flag to say "this is taking a while" rather than inventing its own threshold. */
    readonly onWaiting?: (elapsedMs: number, slow: boolean) => void;
    /* Checked before every attempt and after every response. Returning false ends the probe as `abandoned`,
     * the tab was closed, the component unmounted, a newer probe superseded this one. */
    readonly stillWanted?: () => boolean;
}

/* Poll `url` until something answers. Never throws: a caller is deciding what to SHOW, and every outcome here
 * is a thing to show rather than an error to handle. */
export const probeUntilReachable = async (url: string, options: ProbeOptions = {}): Promise<ProbeOutcome> => {
    const { onWaiting, stillWanted } = options;
    const startedAt = Date.now();
    for (;;) {
        if (stillWanted?.() === false) {
            return "abandoned";
        }
        try {
            await fetch(url, { mode: "no-cors", cache: "no-store" });
            return stillWanted?.() === false ? "abandoned" : "reachable";
        } catch {
            const elapsed = Date.now() - startedAt;
            if (elapsed > PROBE_GIVE_UP_MS) {
                return "gaveUp";
            }
            onWaiting?.(elapsed, elapsed > PROBE_SLOW_AFTER_MS);
            await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
        }
    }
};

export interface ForwardedPortTab {
    readonly port: number;
    // Carried across from a link that named a path on localhost, so Ctrl+clicking one lands where it pointed.
    readonly path?: string;
    // The caller's own route to POST /ports/forward, the web app and the Ports extension reach the daemon
    // through different clients, and which one is not this function's business. Answers undefined when the
    // sandbox has no public preview hostname at all.
    readonly forward: (port: number) => Promise<string | undefined>;
    // Somewhere on the page to also say what went wrong, for a caller that has a place for it. The tab always
    // says it too, because the tab is where the user is looking.
    readonly onError?: (message: string) => void;
}

/* Forward a port and open it, narrating the wait in the tab itself.
 *
 * THE TAB MUST OPEN SYNCHRONOUSLY, inside the click's user activation, or a popup blocker eats it, and the
 * forward plus the probe take anywhere from a moment to a minute. So a blank tab opens first, writes what it is
 * waiting for, and navigates once the address answers. Returns immediately for the same reason: the caller is
 * an event handler, and everything after the first line happens in the tab.
 *
 * `opener` is severed by hand rather than with `noopener`, which would return null and leave nothing to
 * navigate. The tab will show arbitrary app content, so it does not get a handle back on the shell. */
export const openForwardedPort = ({ port, path = "", forward, onError }: ForwardedPortTab): void => {
    const tab = window.open("", "_blank");
    if (tab !== null) {
        tab.opener = null;
    }
    // The tab, while it is still there to write to. A user who closed it has said they are done waiting, and a
    // popup the browser blocked was never there, both mean "nothing left to narrate to".
    const live = (): Window | undefined => (tab !== null && !tab.closed ? tab : undefined);
    const show = (text: string): void => {
        const showing = live();
        if (showing !== undefined) {
            showing.document.body.textContent = text;
        }
    };
    const fail = (message: string): void => {
        show(message);
        onError?.(message);
    };
    show(`Forwarding port ${port} from your sandbox…`);
    void (async () => {
        try {
            const previewUrl = await forward(port);
            if (previewUrl === undefined) {
                fail(`This sandbox has no public preview hostname, so ports can't be previewed from the browser.`);
                return;
            }
            show(`Waiting for ${previewUrl} to come up…`);
            const outcome = await probeUntilReachable(previewUrl, { stillWanted: () => live() !== undefined });
            if (outcome === "gaveUp") {
                fail(`The preview address didn't come up — the server may have stopped, or DNS is still propagating. Close this tab and try again.`);
                return;
            }
            const arrived = live();
            if (outcome === "reachable" && arrived !== undefined) {
                arrived.location.href = `${previewUrl}${path}`;
            }
        } catch (error) {
            fail(error instanceof Error ? error.message : `Forwarding port ${port} failed.`);
        }
    })();
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/* A terminal link that points at localhost names the SANDBOX's loopback, not the user's machine, the process
 * that printed it runs inside the remote container, so opening it verbatim is a dead link. This is the reading
 * of one: its port and the path to carry over, or undefined for anything that is not a sandbox-loopback
 * http(s) link (which the caller opens as-is). */
export const parseLoopbackLink = (uri: string): { port: number; path: string } | undefined => {
    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        return undefined;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !LOOPBACK_HOSTS.has(url.hostname)) {
        return undefined;
    }
    const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return { port, path: `${url.pathname}${url.search}${url.hash}` };
};
