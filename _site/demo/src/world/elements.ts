import { previewDocument } from "../daemon/workspace/previewPage";
import { sandboxAddress } from "./addresses";

// WHERE AN ELEMENT LOADS A SANDBOX ADDRESS IN THE DEMO'S WORLD. The transports (transport.ts) answer what the editor
// fetches; what it hands the browser instead (a <video>'s source, a download link, a served page's frame, a running
// app's frame) the browser requests itself, and every demo sandbox address sits on the reserved `.demo.invalid` TLD. The
// editor passes each such address through its element-address seam (web client/endpoint/elementAddress.ts), and this
// module is the demo's side of it:
//
// - Most go to the demo's element worker (element-worker.js), at `<base>__sandbox/<world>/<host>/<path>` on the page's
//   own origin, which it relays to this tab over a BroadcastChannel and which this tab answers through its own fetch, so
//   the same handlers answer an element as answer the editor: a player's Range windows, a download's attachment, an
//   app page's stylesheets and links. A worker sees a frame's or a download's navigation only to its own origin, which is
//   why the address moves onto it rather than the worker watching `.demo.invalid`.
// - A served page's preview cannot go there: its frame is sandboxed into an opaque origin, and no worker sees an opaque
//   origin's requests. It is handed the page as one document instead, its files carried inside (previewPage.ts).
//
// `<world>` names this tab, so an address another tab minted is never answered with this one's state.

const CHANNEL = `intentic-demo-elements`;
const WORKER = `element-worker.js`;
const PREVIEW_PATH = `/workspace/preview/`;
// Documents handed to preview frames, kept for the last few: a page re-mints on every edit, and a frame still showing
// an older one must not lose it mid-load.
const DOCUMENTS_KEPT = 16;

const world = crypto.randomUUID().slice(0, 8);
const base = import.meta.env.BASE_URL;
const documents = new Map<string, string>();

interface Ask {
    readonly kind: `ask`;
    readonly id: string;
    readonly world: string;
    readonly url: string;
    readonly method: string;
    readonly headers: [string, string][];
    readonly body?: ArrayBuffer;
}

// The page as one document, as an address this tab holds; the same address for the same page.
const documentAddress = (url: URL): string | undefined => {
    const known = documents.get(url.href);
    if (known !== undefined) {
        return known;
    }
    const page = previewDocument(url);
    if (page === undefined) {
        return undefined;
    }
    const address = URL.createObjectURL(new Blob([page], { type: `text/html` }));
    documents.set(url.href, address);
    if (documents.size > DOCUMENTS_KEPT) {
        const [oldest, held] = documents.entries().next().value ?? [];
        if (oldest !== undefined && held !== undefined) {
            documents.delete(oldest);
            URL.revokeObjectURL(held);
        }
    }
    return address;
};

/** The demo's element-address resolver: a sandbox address of this world as one an element can load. */
const elementAddressFor = (raw: string): string => {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        // allow(silent-catch): what is not an address is no sandbox's, and goes to the element as it came.
        return raw;
    }
    if (!sandboxAddress(url, `GET`)) {
        return raw;
    }
    if (url.pathname.startsWith(PREVIEW_PATH)) {
        return documentAddress(url) ?? raw;
    }
    return `${location.origin}${base}__sandbox/${world}/${url.host}${url.pathname}${url.search}`;
};

// One relayed request, answered by this tab's own transports exactly as if the editor had fetched it.
const answer = async (channel: BroadcastChannel, ask: Ask): Promise<void> => {
    const init: RequestInit = { method: ask.method, headers: ask.headers };
    if (ask.body !== undefined) {
        init.body = ask.body;
    }
    try {
        const response = await fetch(ask.url, init);
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no targetOrigin.
        channel.postMessage({ kind: `answer`, id: ask.id, status: response.status, headers: [...response.headers], body: await response.arrayBuffer() });
    } catch (error) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no targetOrigin.
        channel.postMessage({ kind: `answer`, id: ask.id, status: 502, headers: [[`content-type`, `text/plain; charset=utf-8`]], body: new TextEncoder().encode(String(error)).buffer });
    }
};

/** Hands the editor the resolver and starts answering the worker; a browser with no workers keeps the addresses. */
export const installElementAddresses = (): void => {
    if (!(`serviceWorker` in navigator) || !window.isSecureContext) {
        return;
    }
    const channel = new BroadcastChannel(CHANNEL);
    channel.addEventListener(`message`, (event: MessageEvent<Ask | { readonly kind: `answer` }>) => {
        // The channel is this origin's own: only the element worker and other demo tabs post on it, in these two shapes.
        const said = event.data;
        if (said.kind === `ask` && said.world === world) {
            void answer(channel, said);
        }
    });
    window.__INTENTIC_ELEMENT_ADDRESS__ = elementAddressFor;
    void (async () => {
        try {
            await navigator.serviceWorker.register(`${base}${WORKER}`, { scope: base, updateViaCache: `none` });
        } catch (error) {
            console.warn(`[demo] the element worker could not be registered, so media, downloads and previews will not load:`, error);
        }
    })();
};
