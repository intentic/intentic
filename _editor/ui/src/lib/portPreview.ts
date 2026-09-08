// Preview hostnames may not resolve yet when minted, and both an iframe and a raw tab fail silently if used too
// early. This polls a reserved, CORS-open endpoint (`/__intentic/preview-probe`) rather than plain-fetching the
// page, since a cross-origin `no-cors` request can't tell a real answer from an edge error page.

// Proxy's reserved path (daemon: PREVIEW_PROBE_PATH), duplicated since the kit takes no daemon dependency.
const PROBE_PATH = "/__intentic/preview-probe";

// Fixed, not per-caller: resolve time is a property of the preview fabric, not of the button waiting on it.
const PROBE_INTERVAL_MS = 3000;
const PROBE_SLOW_AFTER_MS = 30_000;
// Generous enough for first-start propagation, bounded so a dead name isn't polled forever.
const PROBE_GIVE_UP_MS = 180_000;

// What the address resolves to; only `serving` is framed, the rest are screens to show instead.
export type PreviewState = "serving" | "starting" | "several" | "stopped" | "unforwarded";

export interface PreviewServer {
    readonly port: number;
    // Which package inside the repo bound it (`_editor/web`), absent when the process sits at the repo root.
    readonly dir?: string;
}

// Outcome of a probe:
// - reached: the hostname is this sandbox's preview proxy; `state` says what it serves.
// - unreachable: nothing answered as a preview before the deadline; distinct from `reached` with a stopped state.
// - abandoned: the caller stopped wanting it (tab closed, unmounted, superseded).
export type PreviewProbe =
    | { readonly outcome: "reached"; readonly state: PreviewState; readonly servers: readonly PreviewServer[] }
    | { readonly outcome: "unreachable" }
    | { readonly outcome: "abandoned" };

export interface ProbeOptions {
    // Called after each failed attempt with elapsed time; use `slow` rather than inventing a threshold.
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

// One probe attempt; `undefined` for anything that isn't this proxy (rejected fetch, non-200, a body that isn't
// its shape). Never throws.
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

// Polls `url` until its preview proxy answers. Never throws: every outcome is a thing to show, not an error to
// handle.
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
    // Caller's route to POST /ports/forward; returns undefined when the sandbox has no public hostname.
    readonly forward: (port: number) => Promise<string | undefined>;
    // Optional extra place to show the error; the opened tab always shows it too.
    readonly onError?: (message: string) => void;
}

// Forwards a port, opening a tab synchronously within the click's user activation (a later open would hit a
// popup blocker). `opener` is severed by hand, not via `noopener`, which would leave no handle to navigate.
export const openForwardedPort = ({ port, path = "", forward, onError }: ForwardedPortTab): void => {
    const tab = window.open("", "_blank");
    if (tab !== null) {
        tab.opener = null;
    }
    // The tab, if still open; a closed or blocked tab means nothing left to narrate to.
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

// A `localhost` link printed by a process inside the sandbox names the sandbox's own loopback, not the user's
// machine; opening it verbatim is dead. Reads the port and path from such a link, or `undefined` if it isn't one.
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
