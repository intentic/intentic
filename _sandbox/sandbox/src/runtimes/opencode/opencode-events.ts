import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import { within } from "@intentic/base/async";

// One server's event stream, read once and handed to every listener. OpenCode 2 publishes a single stream for the whole
// server, every directory and session on it, live only: what happens while nobody is subscribed is never sent again.
// So the stream is opened at boot, before any turn can prompt, and a turn listens on it rather than opening its own.

export interface OpenCodeListener {
    readonly event: (event: OpenCodeEvent) => void;
    // The stream is gone and with it every event from here on, so a turn waiting on its end would wait for ever.
    readonly lost: (reason: Error) => void;
}

export interface OpenCodeEvents {
    // Hears every event from now on, until the returned function is called.
    readonly listen: (listener: OpenCodeListener) => () => void;
    // Ends the stream for good; idempotent.
    readonly close: () => void;
    // Ends it for a reason the caller learned elsewhere (the server exited), telling every listener it is lost. Not
    // reported to `ended`: the caller already knows.
    readonly lose: (reason: Error) => void;
}

// How long the stream gets to say it is connected; a server that has printed its address answers within milliseconds.
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Opens the server's event stream and resolves once the server has confirmed it (its first event), so nothing a turn
 * prompts afterwards can be missed. Each event goes to every listener; anything that ends the stream is reported to
 * the listeners then (`lost`) and to `ended`, which is how the service learns its server is no longer usable. A stream
 * that ends before the server confirmed it fails the open instead, at once and with its own error: the caller is still
 * booting, and an `ended` then would have it forget the very boot it is in the middle of.
 */
export const openEventStream = async (
    client: OpenCodeClient,
    options: { readonly onEvent?: (event: OpenCodeEvent) => void; readonly ended: (reason: Error) => void },
): Promise<OpenCodeEvents> => {
    const stop = new AbortController();
    const listeners = new Set<OpenCodeListener>();
    let closed = false;
    // Set by the server's own confirmation; until then a failure belongs to the open, not to `ended`.
    let confirmed = false;
    let failedBeforeConfirmed: Error | undefined;
    const ready = Promise.withResolvers<void>();
    const end = (reason: Error): void => {
        if (closed) {
            return;
        }
        closed = true;
        stop.abort();
        if (!confirmed) {
            failedBeforeConfirmed = reason;
            ready.resolve();
            return;
        }
        for (const listener of listeners) {
            listener.lost(reason);
        }
        listeners.clear();
        options.ended(reason);
    };
    void (async () => {
        try {
            for await (const event of client.event.subscribe({ signal: stop.signal })) {
                if (event.type === "server.connected") {
                    confirmed = true;
                    ready.resolve();
                    continue;
                }
                options.onEvent?.(event);
                for (const listener of listeners) {
                    listener.event(event);
                }
            }
            end(new Error("OpenCode's event stream ended."));
        } catch (error) {
            end(error instanceof Error ? error : new Error(String(error)));
        }
    })();
    const answered = await within(
        ready.promise.then(() => true),
        CONNECT_TIMEOUT_MS,
        false,
    );
    if (failedBeforeConfirmed !== undefined) {
        throw failedBeforeConfirmed;
    }
    if (!answered || closed) {
        const reason = new Error("OpenCode's event stream did not connect.");
        end(reason);
        throw reason;
    }
    return {
        listen: (listener) => {
            if (closed) {
                listener.lost(new Error("OpenCode's event stream ended."));
                return () => {};
            }
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        close: () => {
            if (!closed) {
                closed = true;
                listeners.clear();
                stop.abort();
            }
        },
        lose: (reason) => {
            if (closed) {
                return;
            }
            closed = true;
            stop.abort();
            for (const listener of listeners) {
                listener.lost(reason);
            }
            listeners.clear();
        },
    };
};
