// Two globals every browser call resolves at call time: `fetch` covers the platform, the daemon and the typed client;
// `WebSocket` covers the terminal and browser view. No app module knows the demo exists. Both demo origins sit under
// the reserved `.invalid` TLD, so an escaped request dies rather than reaching a real host.

// Platform origin; useApi appends /rpc, better-auth appends /api/auth.
const DEMO_API_ORIGIN = `https://api.demo.invalid`;
// Active sandbox's daemon origin, announced by the platform's sandbox row.
export const DEMO_DAEMON_ORIGIN = `https://sandbox.demo.invalid`;

export type DemoHandler = (request: Request, url: URL) => Promise<Response>;

const urlOf = (input: RequestInfo | URL): URL | undefined => {
    try {
        return new URL(typeof input === `string` ? input : input instanceof URL ? input.href : input.url, window.location.href);
    } catch {
        return undefined;
    }
};

// Claims two extra cases beyond the origins above: the endpoint selector's loopback probes (`local-<digest>.<zone>` and
// `127.0.0.1:<port>`/health), answered here so they fail fast instead of hanging.
const claimed = (url: URL, handlers: { platform: DemoHandler; daemon: DemoHandler }): DemoHandler | undefined => {
    if (url.origin === DEMO_API_ORIGIN) {
        return handlers.platform;
    }
    // `hostname`, not `host`: the loopback candidate carries a port on purpose.
    if (url.hostname.endsWith(`demo.invalid`) || (url.hostname === `127.0.0.1` && url.pathname === `/health`)) {
        return handlers.daemon;
    }
    return undefined;
};

/** Routes the demo's own addresses to their handlers; every other request (the app's assets) passes through. */
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

// Third transport: `sandboxUpload` posts files via XHR, since streaming fetch needs HTTP/2 but the loopback shortcut is
// HTTP/1.1. Subclassing keeps an unclaimed URL untouched; a claimed one fires progress/load/loadend in wire order.
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

// Socket driven like a real one: opens on a macrotask, emits `message`, closes. Only what consumers touch is
// implemented; class constants come free since the global is proxied, not replaced.
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
        // Never synchronous: a real socket can't open before its constructor returns.
        setTimeout(() => {
            if (this.readyState !== DemoSocket.CONNECTING) {
                return;
            }
            this.readyState = DemoSocket.OPEN;
            this.dispatchEvent(new Event(`open`));
            this.session(this);
        });
    }

    /** Deliver one server frame to the app, as the wire would: JSON as text, a picture as bytes. */
    emit(data: string | ArrayBuffer): void {
        if (this.readyState === DemoSocket.OPEN) {
            this.dispatchEvent(new MessageEvent(`message`, { data }));
        }
    }

    // App's client frames (input, resize, ping, browser view's bind/pause/resume) re-dispatched as a `client` event so
    // a session can answer them.
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

/** Claims the demo daemon's WebSocket URLs; anything else gets a real socket. */
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

// JSON in the shape oRPC and sandboxJson expect; contract types on each handler keep this honest.
export const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": `application/json` } });

// Daemon's own refusal shape (`{ error }`); sandboxError surfaces it as the user-facing message.
export const refuse = (message: string, status = 403): Response => json({ error: message }, status);
