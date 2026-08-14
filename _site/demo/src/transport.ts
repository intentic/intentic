/* WHERE THE DEMO ATTACHES to the real app: the two globals every browser→outside call resolves at call time.
 *
 * `fetch` covers all of it — the platform (better-auth's session probe and the oRPC client in useApi), the
 * daemon's path-based calls (sandboxClient), and the typed client with its event-iterator streams (sandboxRpc,
 * whose fetch is a per-request hook precisely so a wrapper can replace it). `WebSocket` covers the terminal and
 * the agent's browser view, which are the only two things that never speak HTTP.
 *
 * So the demo needs no branch inside the app: not one production module knows it exists. What the app asks for,
 * the fixture answers.
 *
 * Both demo origins sit under the reserved `.invalid` TLD (RFC 2606), which can never resolve. If a request
 * ever escapes the handlers below, it dies in the client instead of reaching a real host. */

// The platform. useApi appends /rpc; better-auth appends /api/auth.
const DEMO_API_ORIGIN = `https://api.demo.invalid`;
// The active sandbox's daemon, as announced by the demo platform's sandbox row.
export const DEMO_DAEMON_ORIGIN = `https://sandbox.demo.invalid`;

export type DemoHandler = (request: Request, url: URL) => Promise<Response>;

const urlOf = (input: RequestInfo | URL): URL | undefined => {
    try {
        return new URL(typeof input === `string` ? input : input instanceof URL ? input.href : input.url, window.location.href);
    } catch {
        return undefined;
    }
};

/* Which requests the demo answers. Broader than the two origins above by exactly two cases, both of them the
 * endpoint selector looking for a loopback shortcut to the daemon (useEndpoint → endpoint.ts): it derives an
 * `https://local-<digest>.<zone>` candidate from the sandbox's own connect token and an `http://127.0.0.1:<port>`
 * one beside it, and probes `/health` on each. Left unclaimed they are two failed requests in the console of
 * every demo — so the fixture answers them (with a 404: there is no shortcut), and the selector settles on the
 * demo daemon exactly as it settles on a tunnel. */
const claimed = (url: URL, handlers: { platform: DemoHandler; daemon: DemoHandler }): DemoHandler | undefined => {
    if (url.origin === DEMO_API_ORIGIN) {
        return handlers.platform;
    }
    // `hostname`, not `host`: the loopback candidate carries a port, and its whole point is being on one.
    if (url.hostname.endsWith(`demo.invalid`) || (url.hostname === `127.0.0.1` && url.pathname === `/health`)) {
        return handlers.daemon;
    }
    return undefined;
};

/** Route the demo's own addresses to their handlers and leave every other request (the app's assets) alone. */
export const installFetch = (handlers: { platform: DemoHandler; daemon: DemoHandler }): void => {
    const passThrough = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
        const url = urlOf(input);
        const handler = url === undefined ? undefined : claimed(url, handlers);
        if (handler === undefined || url === undefined) {
            return passThrough(input, init);
        }
        return handler(new Request(input as RequestInfo, init), url);
    };
};

/* THE THIRD TRANSPORT, and the only one the app opens by hand: `sandboxUpload` (sandboxClient.ts) posts every
 * dropped file over XMLHttpRequest rather than fetch, because a streaming fetch body needs HTTP/2 and the
 * daemon's loopback shortcut is HTTP/1.1. So the drop zone is the one surface the fetch shim above cannot see,
 * and without this the tour ends at "Scanning dropped folder… 12 files" — the walk works, then every part dies
 * against an origin that can never resolve.
 *
 * Subclassing the real XMLHttpRequest is what keeps the pass-through honest: an unclaimed URL never leaves the
 * browser's own implementation (nothing is reimplemented for it), and only a claimed one takes the branch below.
 * There `status` and `responseText` are defined as own properties — the prototype's are getters over a request
 * that was never sent — and the upload's `progress` plus the request's `load`/`loadend` fire in the order the
 * wire would, which is all `sendPart` listens for. */
export const installXhr = (handlers: { platform: DemoHandler; daemon: DemoHandler }): void => {
    globalThis.XMLHttpRequest = class DemoXhr extends XMLHttpRequest {
        #handler: DemoHandler | undefined;
        #url = ``;
        #method = `GET`;
        #headers = new Headers();

        override open(method: string, url: string | URL, async = true, username?: string | null, password?: string | null): void {
            const parsed = urlOf(url);
            this.#handler = parsed === undefined ? undefined : claimed(parsed, handlers);
            if (this.#handler === undefined) {
                super.open(method, url, async, username, password);
                return;
            }
            this.#url = String(parsed);
            this.#method = method;
            this.#headers = new Headers();
        }

        override setRequestHeader(name: string, value: string): void {
            if (this.#handler === undefined) {
                super.setRequestHeader(name, value);
                return;
            }
            this.#headers.set(name, value);
        }

        override send(body?: Document | XMLHttpRequestBodyInit | null): void {
            const handler = this.#handler;
            if (handler === undefined) {
                super.send(body);
                return;
            }
            const url = new URL(this.#url);
            const total = body instanceof Blob ? body.size : 0;
            void handler(new Request(url, { method: this.#method, headers: this.#headers, body: body as BodyInit }), url).then(async (response) => {
                const text = await response.text();
                Object.defineProperties(this, {
                    status: { value: response.status, configurable: true },
                    responseText: { value: text, configurable: true },
                });
                this.upload.dispatchEvent(new ProgressEvent(`progress`, { lengthComputable: true, loaded: total, total }));
                this.dispatchEvent(new ProgressEvent(`load`));
                this.dispatchEvent(new ProgressEvent(`loadend`));
            });
        }

        override abort(): void {
            if (this.#handler === undefined) {
                super.abort();
                return;
            }
            this.dispatchEvent(new ProgressEvent(`abort`));
            this.dispatchEvent(new ProgressEvent(`loadend`));
        }
    };
};

/* A socket the app drives exactly as it drives a real one: it opens on a macrotask, emits `message` events, and
 * closes. Only what the two consumers touch is implemented — addEventListener/close/send/readyState — and the
 * class constants come free, because the global is proxied rather than replaced (see installWebSocket). */
class DemoSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState: number = DemoSocket.CONNECTING;

    constructor(
        readonly url: string,
        private readonly session: (socket: DemoSocket) => void,
    ) {
        super();
        // Never synchronously: a real socket cannot open before its constructor returns, and terminalSession
        // registers its listeners after ours would already have fired.
        setTimeout(() => {
            if (this.readyState !== DemoSocket.CONNECTING) {
                return;
            }
            this.readyState = DemoSocket.OPEN;
            this.dispatchEvent(new Event(`open`));
            this.session(this);
        });
    }

    /** Deliver one server frame to the app, as the wire would. */
    emit(data: string): void {
        if (this.readyState === DemoSocket.OPEN) {
            this.dispatchEvent(new MessageEvent(`message`, { data }));
        }
    }

    /* The app's client frames (input, resize, ping, and the browser view's `bind`/`pause`/`resume`),
     * re-dispatched as a `client` event so a session can answer them — which is what lets the recorded browser
     * switch pages when the visitor clicks a tab, instead of playing one stream at whatever the app asked for. */
    send(data: string): void {
        this.dispatchEvent(new MessageEvent(`client`, { data }));
    }

    close(): void {
        if (this.readyState === DemoSocket.CLOSED) {
            return;
        }
        this.readyState = DemoSocket.CLOSED;
        this.dispatchEvent(new CloseEvent(`close`, { code: 1000, wasClean: true }));
    }
}

export type DemoSession = (socket: DemoSocket) => void;
export type { DemoSocket };

/** Claim the demo daemon's WebSocket URLs; anything else still gets a real socket. */
export const installWebSocket = (session: (url: URL) => DemoSession | undefined): void => {
    const wsOrigin = DEMO_DAEMON_ORIGIN.replace(/^https/, `wss`);
    globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
        construct: (target, args: [string | URL, (string | string[])?]) => {
            const url = urlOf(args[0]);
            const replay = url?.origin === wsOrigin ? session(url) : undefined;
            return replay === undefined ? new target(...args) : new DemoSocket(String(args[0]), replay);
        },
    });
};

// JSON in the shape the app's clients expect: oRPC reads the body, sandboxJson reads the body, and neither
// re-validates it — the contract types on each handler are what keep the fixture honest.
export const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": `application/json` } });

// The daemon's own refusal shape (`{ error }`), which sandboxError already surfaces as the user-facing message.
export const refuse = (message: string, status = 403): Response => json({ error: message }, status);
