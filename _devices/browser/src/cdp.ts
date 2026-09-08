import { pollUntil } from "@intentic/base/async";
import { BrowserError } from "./types.js";

// Chrome DevTools Protocol subset for driving a page: HTTP handshake to find tabs, then one WebSocket per tab
// carrying JSON-RPC. Hand-rolled because Bun's `connectOverCDP` cannot reach a browser (stalls on the WebSocket
// upgrade); Bun's global WebSocket does connect. Correlates by request id; events (no `id`) are dropped since this only
// asks questions.

// Generous enough for a slow navigation, short enough to fail legibly instead of hanging upstream.
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

// Whether anything is listening as a DevTools endpoint; used both to check "already up" and to wait for start.
export const probe = async (port: number): Promise<boolean> => {
    try {
        const response = await fetch(endpoint(port, "/json/version"), { signal: AbortSignal.timeout(1000) });
        return response.ok;
    } catch {
        return false;
    }
};

export const waitForPort = async (port: number, timeoutMs: number): Promise<void> => {
    if (!(await pollUntil(() => probe(port), { intervalMs: 150, timeoutMs }))) {
        throw new BrowserError(`The browser did not open its debugging port (${port}) in time.`);
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
