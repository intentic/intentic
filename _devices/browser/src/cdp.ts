import { BrowserError, BrowserTimeoutError } from "./types.js";

// Chrome DevTools Protocol subset for driving a page: HTTP handshake to find tabs, then one WebSocket per tab
// carrying JSON-RPC. Hand-rolled because Bun's `connectOverCDP` cannot reach a browser (stalls on the WebSocket
// upgrade); Bun's global WebSocket does connect. Correlates by request id; events (no `id`) go to the session's one
// listener, which is how the page's console is collected (console.ts).

// Generous enough for a slow navigation, short enough to fail legibly instead of hanging upstream.
const CALL_TIMEOUT_MS = 30_000;

export interface CdpTarget {
    readonly id: string;
    readonly title: string;
    readonly url: string;
    readonly type: string;
    readonly webSocketDebuggerUrl?: string;
}

// A CDP method's parameters, or an event's: their shape is the protocol's, per method, and each caller reads its own.
export type CdpParams = Record<string, unknown>;

// A CDP event: a message the browser sends unasked, once its domain is enabled.
export type CdpEventListener = (method: string, params: CdpParams) => void;

export interface CdpSession {
    // `timeoutMs` replaces the default 30 s for a call that is allowed longer (an awaited page script with its own deadline).
    readonly send: <T = CdpParams>(method: string, params?: CdpParams, timeoutMs?: number) => Promise<T>;
    readonly close: () => void;
}

const endpoint = (port: number, path: string): string => `http://127.0.0.1:${port}${path}`;

// The path of the browser-wide debugging target that answers on `port` (`/devtools/browser/<id>`, a new id every time a
// browser starts), or undefined when nothing answers there as a DevTools endpoint.
export const browserTargetPath = async (port: number): Promise<string | undefined> => {
    try {
        const response = await fetch(endpoint(port, "/json/version"), { signal: AbortSignal.timeout(1000) });
        // SAFETY: only read as a string below, and a body without the field reads as no endpoint.
        const body = response.ok ? ((await response.json()) as { webSocketDebuggerUrl?: string }) : undefined;
        const url = String(body?.webSocketDebuggerUrl);
        return URL.canParse(url) ? new URL(url).pathname : undefined;
    } catch {
        // allow(silent-catch): a port that refuses, hangs or answers something else is simply not a debugging endpoint
        return undefined;
    }
};

export const listTargets = async (port: number): Promise<CdpTarget[]> => {
    const response = await fetch(endpoint(port, "/json/list"), { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        throw new BrowserError(`No browser is answering on the debugging port (${port}).`);
    }
    // Only real pages; a browser also exposes service workers, extension backgrounds, and its own devtools UI.
    return ((await response.json()) as CdpTarget[]).filter((target) => target.type === "page" && !target.url.startsWith("devtools://"));
};

export const newTab = async (port: number, url: string): Promise<CdpTarget> => {
    const response = await fetch(endpoint(port, `/json/new?${encodeURIComponent(url)}`), { method: "PUT" }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        throw new BrowserError("The browser refused to open a new tab.");
    }
    return (await response.json()) as CdpTarget;
};

export const attach = async (wsUrl: string, onEvent?: CdpEventListener): Promise<CdpSession> => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let nextId = 1;

    await new Promise<void>((resolvePromise, reject) => {
        socket.addEventListener("open", () => resolvePromise(), { once: true });
        socket.addEventListener("error", () => reject(new BrowserError("Could not connect to the browser's debugging socket.")), { once: true });
    });

    socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
            id?: number;
            method?: string;
            params?: CdpParams;
            result?: unknown;
            error?: { message?: string };
        };
        if (message.id === undefined) {
            if (message.method !== undefined) {
                onEvent?.(message.method, message.params ?? {});
            }
            return;
        }
        const waiter = pending.get(message.id);
        if (waiter === undefined) {
            return;
        }
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error !== undefined) {
            waiter.reject(new BrowserError(message.error.message ?? "The browser refused that."));
            return;
        }
        waiter.resolve(message.result);
    });

    // A socket that closes mid-call fails every call in flight, rather than leaving them to time out one by one.
    socket.addEventListener("close", () => {
        for (const [, waiter] of pending) {
            clearTimeout(waiter.timer);
            waiter.reject(new BrowserError("The browser closed the connection: the tab was probably closed."));
        }
        pending.clear();
    });

    return {
        send: <T>(method: string, params: CdpParams = {}, timeoutMs = CALL_TIMEOUT_MS) =>
            new Promise<T>((resolvePromise, reject) => {
                const id = nextId++;
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new BrowserTimeoutError(`The page did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s.`));
                }, timeoutMs);
                pending.set(id, { resolve: resolvePromise as (value: unknown) => void, reject, timer });
                socket.send(JSON.stringify({ id, method, params }));
            }),
        close: () => socket.close(),
    };
};
