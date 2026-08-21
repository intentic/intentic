import { BrowserError } from "./types.js";

/* The Chrome DevTools Protocol, as much of it as driving a page needs: an HTTP handshake to find the tabs, then
 * one WebSocket per tab carrying JSON-RPC.
 *
 * Hand-rolled rather than puppeteer/playwright, for a reason that was measured rather than assumed, and NOT the
 * one you would guess. Bundling is not the obstacle: Playwright packs into the `bun build --compile` binary this
 * ships inside for about 6 MB. What it cannot do is reach a browser from Bun. `connectOverCDP` fetches the
 * debugger's WebSocket URL over HTTP and then stalls on the upgrade until it times out, compiled and uncompiled
 * alike, while the same script on Node drives the page fine. Bun's global `WebSocket` does connect, which is
 * what the rest of this file is built on. The README carries the versions and says when to re-test.
 *
 * Correlation is the only real machinery: every request gets an id and the matching response resolves it. Events
 * (a message with a `method` and no `id`) are dropped, this package asks questions and does not subscribe. */

// A page that stops answering would otherwise hold a tool call until something far upstream gave up. Generous
// enough for a slow navigation, short enough to be a legible failure.
const CALL_TIMEOUT_MS = 30_000;

export interface CdpTarget {
    readonly id: string;
    readonly title: string;
    readonly url: string;
    readonly type: string;
    readonly webSocketDebuggerUrl?: string;
}

export interface CdpSession {
    readonly send: <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>) => Promise<T>;
    readonly close: () => void;
}

const endpoint = (port: number, path: string): string => `http://127.0.0.1:${port}${path}`;

// Whether anything is listening as a DevTools endpoint. Used both to decide "is a browser already up" and to
// wait for one that is starting.
export const probe = async (port: number): Promise<boolean> => {
    try {
        const response = await fetch(endpoint(port, "/json/version"), { signal: AbortSignal.timeout(1000) });
        return response.ok;
    } catch {
        return false;
    }
};

export const waitForPort = async (port: number, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await probe(port)) {
            return;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
    throw new BrowserError(`The browser did not open its debugging port (${port}) in time.`);
};

export const listTargets = async (port: number): Promise<CdpTarget[]> => {
    const response = await fetch(endpoint(port, "/json/list"), { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        throw new BrowserError(`No browser is answering on the debugging port (${port}).`);
    }
    // Only real pages: a browser also exposes service workers, extension backgrounds and its own devtools UI,
    // none of which anyone means by "the page".
    return ((await response.json()) as CdpTarget[]).filter((target) => target.type === "page" && !target.url.startsWith("devtools://"));
};

export const newTab = async (port: number, url: string): Promise<CdpTarget> => {
    const response = await fetch(endpoint(port, `/json/new?${encodeURIComponent(url)}`), { method: "PUT" }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        throw new BrowserError("The browser refused to open a new tab.");
    }
    return (await response.json()) as CdpTarget;
};

export const attach = async (wsUrl: string): Promise<CdpSession> => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let nextId = 1;

    await new Promise<void>((resolvePromise, reject) => {
        socket.addEventListener("open", () => resolvePromise(), { once: true });
        socket.addEventListener("error", () => reject(new BrowserError("Could not connect to the browser's debugging socket.")), { once: true });
    });

    socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
        if (message.id === undefined) {
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
        send: <T>(method: string, params: Record<string, unknown> = {}) =>
            new Promise<T>((resolvePromise, reject) => {
                const id = nextId++;
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new BrowserError(`The page did not answer "${method}" within ${CALL_TIMEOUT_MS / 1000}s.`));
                }, CALL_TIMEOUT_MS);
                pending.set(id, { resolve: resolvePromise as (value: unknown) => void, reject, timer });
                socket.send(JSON.stringify({ id, method, params }));
            }),
        close: () => socket.close(),
    };
};
