import type { ListenerDispatchFrame, ListenerMessage, ListenerStatus } from "@intentic/sandbox-contract";
import type { Logger } from "./log.js";

// The gateway's client for the daemon's provider-scoped listener routes (app.ts / listener.routes.ts): the daemon holds
// no provider connection itself, so every automation interaction rides these four routes, authenticated with the
// extension's own INTENTIC_EXTENSION_TOKEN: the daemon answers them only for the extension whose manifest declares this
// provider as its listener. Types come from the contract's listener-protocol, the same declaration the daemon parses with.

// The reconcile feed /listeners/<provider>/state serves: enabled automations for this provider, plus the connector
// capabilities this extension contributes, with full config (secrets included, the gateway needs them). `TConfig` is the connector's own config
// shape.
export interface DaemonState<TConfig> {
    readonly automations: ReadonlyArray<{ id: string; enabled: boolean }>;
    readonly connectors: ReadonlyArray<{ id: string; config: TConfig }>;
}

export interface DaemonClient<TConfig> {
    readonly state: () => Promise<DaemonState<TConfig>>;
    readonly dispatch: (message: ListenerMessage) => Promise<void>;
    readonly dispatchStreaming: (message: ListenerMessage, onFrame: (frame: ListenerDispatchFrame) => void) => Promise<void>;
    // Reports never reject: a connector fires them and moves on, so a report the daemon did not take is logged here.
    readonly failure: (detail: string) => Promise<void>;
    readonly status: (snapshot: ListenerStatus) => Promise<void>;
}

// The header the daemon's extension grant reads a per-extension token from (the sandbox's auth/grants.ts).
const EXTENSION_TOKEN_HEADER = "x-intentic-extension";

export const createDaemonClient = <TConfig>(provider: string, base: string, token: string, log: Logger): DaemonClient<TConfig> => {
    const url = (path: string): string => `${base}/listeners/${encodeURIComponent(provider)}/${path}`;
    const jsonHeaders = { "content-type": "application/json", [EXTENSION_TOKEN_HEADER]: token };
    const report = async (path: "failure" | "status", body: unknown, context: object): Promise<void> => {
        try {
            const res = await fetch(url(path), { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
            await res.text();
            if (!res.ok) {
                log.warn({ ...context, status: res.status }, `/listeners/${provider}/${path} returned ${res.status}`);
            }
        } catch (error) {
            log.warn({ ...context, err: error }, `/listeners/${provider}/${path} failed`);
        }
    };
    return {
        state: async () => {
            const res = await fetch(url("state"), { headers: { [EXTENSION_TOKEN_HEADER]: token } });
            if (!res.ok) {
                throw new Error(`/listeners/${provider}/state returned ${res.status}`);
            }
            return (await res.json()) as DaemonState<TConfig>;
        },
        dispatch: async (message) => {
            const res = await fetch(url("dispatch"), { method: "POST", headers: jsonHeaders, body: JSON.stringify(message) });
            await res.text();
            if (!res.ok) {
                throw new Error(`/listeners/${provider}/dispatch returned ${res.status}`);
            }
        },
        dispatchStreaming: async (message, onFrame) => {
            const res = await fetch(`${url("dispatch")}?stream=1`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(message) });
            if (!res.ok || res.body === null) {
                await res.text().catch(() => undefined);
                throw new Error(`/listeners/${provider}/dispatch?stream returned ${res.status}`);
            }
            const decoder = new TextDecoder();
            let buffer = "";
            const drain = (final: boolean): void => {
                let newline = buffer.indexOf("\n");
                while (newline >= 0) {
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + 1);
                    if (line !== "") {
                        onFrame(JSON.parse(line) as ListenerDispatchFrame);
                    }
                    newline = buffer.indexOf("\n");
                }
                if (final && buffer.trim() !== "") {
                    onFrame(JSON.parse(buffer.trim()) as ListenerDispatchFrame);
                }
            };
            for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
                buffer += decoder.decode(chunk, { stream: true });
                drain(false);
            }
            drain(true);
        },
        failure: (detail) => report("failure", { detail }, { detail }),
        status: (snapshot) => report("status", snapshot, {}),
    };
};
