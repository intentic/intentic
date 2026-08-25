/* WAITING FOR A PREVIEW ADDRESS TO COME UP, and opening a forwarded port in a tab.
 *
 * A sandbox address is previewed at a `preview-<panel>-<id>` / `port-<slot>-<id>` hostname served by the
 * daemon's preview proxy. A slot's FIRST forward mints the name, so the address exists before it resolves, and
 * both ways of showing one fail badly if handed it too early: an iframe that error-pages never retries, and a
 * tab navigated to an unresolvable host shows the browser's own "site can't be reached" with nothing to retry
 * from. So the address is probed until it answers.
 *
 * WHAT THE PROBE ASKS, and why it is not a plain fetch of the page. Cross-origin, a `no-cors` request settles on
 * ANY response and lets you read none of it, so the old probe called an edge's "502, no route for this name" a
 * success — and the panel framed it. Chrome then rendered that error page's own `X-Frame-Options` as
 * "<host> refused to connect", which is how "this sandbox has no preview address" reached the user as a
 * browser-level connection error with no explanation anywhere.
 *
 * The proxy therefore answers ONE reserved path with CORS open (`/__intentic/preview-probe`, see the daemon's
 * panels/preview-proxy.ts, which owns this string and this shape) and tells the truth about itself: whether the
 * hostname reached the sandbox at all, and what it currently resolves to there. A readable answer means the
 * address is real; anything else means it is not, however plausibly the edge answered.
 *
 * Three surfaces had each written the waiting loop: the preview panel's iframe gate, the terminal's Ctrl+click
 * on a localhost link, and the Ports view's Preview button. The last of those is an extension, which could
 * reach neither of the first two, so the loop, the intervals, and the sentence a user reads while waiting all
 * lived in triplicate. */

// The proxy's own path (daemon: PREVIEW_PROBE_PATH). One string, two packages, no shared dependency between
// them: the kit is presentational and takes none.
const PROBE_PATH = "/__intentic/preview-probe";

// Fixed rather than per-caller: how long a freshly-minted name takes to answer is a property of the preview
// fabric, not of the button waiting on it, and three surfaces disagreeing about it was the bug.
const PROBE_INTERVAL_MS = 3000;
const PROBE_SLOW_AFTER_MS = 30_000;
// Generous, because a first start can legitimately spend a minute on propagation, but bounded, so a name that
// will never answer is not polled for the life of the tab.
const PROBE_GIVE_UP_MS = 180_000;

// What the sandbox says the address resolves to. `serving` is the only one worth framing; the rest are screens
// to show, which is why they are carried rather than flattened into a boolean.
export type PreviewState = "serving" | "starting" | "several" | "stopped" | "unforwarded";

export interface PreviewServer {
    readonly port: number;
    // Which package inside the repo bound it (`_editor/web`), absent when the process sits at the repo root.
    readonly dir?: string;
}

/* The outcome of a probe:
 *   · reached      , the hostname IS this sandbox's preview proxy, and `state` is what it serves there
 *   · unreachable  , nothing answered as a preview before the deadline: no route, no DNS, nothing listening at
 *                    the edge. NOT "the dev server is down", which is `reached` with a state that says so
 *   · abandoned    , the caller stopped wanting it (tab closed, component unmounted, newer probe) */
export type PreviewProbe =
    | { readonly outcome: "reached"; readonly state: PreviewState; readonly servers: readonly PreviewServer[] }
    | { readonly outcome: "unreachable" }
    | { readonly outcome: "abandoned" };

export interface ProbeOptions {
    /* Called after each attempt that did not reach the proxy, with how long the wait has run. A caller that
     * narrates progress uses the `slow` flag rather than inventing its own threshold. */
    readonly onWaiting?: (elapsedMs: number, slow: boolean) => void;
    /* Checked before every attempt and after every response. Returning false ends the probe as `abandoned`. */
    readonly stillWanted?: () => boolean;
}

interface ProbeBody {
    readonly proxy?: unknown;
    readonly state?: unknown;
    readonly servers?: unknown;
}

const STATES: readonly PreviewState[] = ["serving", "starting", "several", "stopped", "unforwarded"];

// One attempt. Undefined for every way of not being a preview proxy: a rejected fetch (DNS, refused, an
// opaque cross-origin answer), a non-200, a body that is anybody else's. Never throws.
const askOnce = async (url: string): Promise<{ state: PreviewState; servers: readonly PreviewServer[] } | undefined> => {
    try {
        const response = await fetch(new URL(PROBE_PATH, url).toString(), { cache: "no-store" });
        if (!response.ok) {
            return undefined;
        }
        const body = (await response.json()) as ProbeBody;
        const state = STATES.find((known) => known === body.state);
        if (body.proxy !== "intentic-preview" || state === undefined) {
            return undefined;
        }
        const servers = Array.isArray(body.servers)
            ? body.servers.flatMap((server: unknown) => {
                  const entry = server as { port?: unknown; dir?: unknown };
                  return typeof entry.port === "number" ? [{ port: entry.port, ...(typeof entry.dir === "string" ? { dir: entry.dir } : {}) }] : [];
              })
            : [];
        return { state, servers };
    } catch {
        return undefined;
    }
};

/* Poll `url` until its preview proxy answers. Never throws: a caller is deciding what to SHOW, and every
 * outcome here is a thing to show rather than an error to handle. */
export const probePreview = async (url: string, options: ProbeOptions = {}): Promise<PreviewProbe> => {
    const { onWaiting, stillWanted } = options;
    const startedAt = Date.now();
    for (;;) {
        if (stillWanted?.() === false) {
            return { outcome: "abandoned" };
        }
        const answer = await askOnce(url);
        if (stillWanted?.() === false) {
            return { outcome: "abandoned" };
        }
        if (answer !== undefined) {
            return { outcome: "reached", state: answer.state, servers: answer.servers };
        }
        const elapsed = Date.now() - startedAt;
        if (elapsed > PROBE_GIVE_UP_MS) {
            return { outcome: "unreachable" };
        }
        onWaiting?.(elapsed, elapsed > PROBE_SLOW_AFTER_MS);
        await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
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
            const probe = await probePreview(previewUrl, { stillWanted: () => live() !== undefined });
            if (probe.outcome === "unreachable") {
                fail(
                    `${previewUrl} doesn't reach this sandbox: the address may still be propagating, or this sandbox publishes no preview hostnames. Close this tab and try again.`,
                );
                return;
            }
            if (probe.outcome === "reached" && probe.state !== "serving") {
                fail(`The forward for port ${port} has lapsed: re-open the preview from the Ports view.`);
                return;
            }
            const arrived = live();
            if (probe.outcome === "reached" && arrived !== undefined) {
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
