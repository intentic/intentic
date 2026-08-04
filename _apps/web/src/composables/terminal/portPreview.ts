import type { PortForwardResult } from "@intentic/sandbox-contract";
import { sandboxJson } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";

/* A terminal link that points at localhost names the SANDBOX's loopback, not the user's machine — the process
 * that printed it runs inside the remote container, so opening it verbatim is a dead link. Ctrl+clicking one
 * opens a live preview instead: the daemon forwards the port onto a port-<slot>-<sandboxId>.<zone> hostname
 * through the preview proxy (POST /ports/forward), and the link's path/query/hash ride across. The tab must
 * open synchronously inside the click's user activation (popup blockers), so a blank tab opens first, narrates
 * progress, and navigates once the forward + reachability probe land — on the intentic-provided tunnel a
 * slot's FIRST use mints DNS, which can take a while to resolve. */

const LOOPBACK_HOSTS = new Set([`localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`]);

const PROBE_INTERVAL_MS = 3000;
// Generous: a slot's first forward on the intentic path waits on fresh DNS propagation.
const PROBE_GIVE_UP_MS = 120_000;

// The loopback URL parsed to its port + the path to carry over, or undefined for anything that isn't a
// sandbox-loopback http(s) link (which the caller opens as-is).
export const parseLoopbackLink = (uri: string): { port: number; path: string } | undefined => {
    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        return undefined;
    }
    if ((url.protocol !== `http:` && url.protocol !== `https:`) || !LOOPBACK_HOSTS.has(url.hostname)) {
        return undefined;
    }
    const port = url.port !== `` ? Number(url.port) : url.protocol === `https:` ? 443 : 80;
    return { port, path: `${url.pathname}${url.search}${url.hash}` };
};

// Open a forwarded-port preview for one parsed loopback link. Never throws — failures land as text in the tab.
export const openLoopbackPreview = (link: { port: number; path: string }): void => {
    // Synchronously, inside the click's activation. The tab will show arbitrary app content, so sever the
    // reverse handle by hand — `noopener` would return null and leave nothing to navigate.
    const tab = window.open(``, `_blank`);
    if (tab !== null) {
        tab.opener = null;
    }
    const show = (text: string): void => {
        if (tab !== null && !tab.closed) {
            tab.document.body.textContent = text;
        }
    };
    show(`Forwarding port ${link.port} from your sandbox…`);
    void (async () => {
        try {
            const { previewUrl } = await sandboxJson<PortForwardResult>(`/ports/forward`, jsonBody(`POST`, { port: link.port }));
            if (previewUrl === undefined) {
                show(`This sandbox has no public preview hostname, so ports can't be previewed from the browser.`);
                return;
            }
            // Hand the tab the hostname only once a fetch proves it resolves: `no-cors` resolves on ANY HTTP
            // response and rejects only on DNS/socket failure (the PanelView probe, for the same reason).
            show(`Waiting for ${previewUrl} to come up…`);
            const startedAt = Date.now();
            for (;;) {
                if (tab !== null && tab.closed) {
                    return;
                }
                try {
                    await fetch(previewUrl, { mode: `no-cors`, cache: `no-store` });
                    break;
                } catch {
                    if (Date.now() - startedAt > PROBE_GIVE_UP_MS) {
                        show(
                            `The preview address didn't come up — the server may have stopped, or DNS is still propagating. Close this tab and Ctrl+click the link again.`,
                        );
                        return;
                    }
                    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
                }
            }
            if (tab === null || tab.closed) {
                return;
            }
            tab.location.href = `${previewUrl}${link.path}`;
        } catch (error) {
            show(error instanceof Error ? error.message : `Forwarding port ${link.port} failed.`);
        }
    })();
};
