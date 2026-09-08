import type { ListenerDispatchFrame, ListenerMessage, ListenerStatus } from "@intentic/sandbox-contract";

// The gateway's client for the daemon's provider-scoped listener routes (app.ts / listener.routes.ts): the daemon holds
// no provider connection itself, so every automation interaction rides these four routes, authenticated with
// INTENTIC_PANEL_TOKEN. Types come from the contract's listener-protocol, the same declaration the daemon parses with.

// The reconcile feed /listeners/<provider>/state serves: enabled automations for this provider, plus connector
// capabilities with full config (secrets included, the gateway needs them). `TConfig` is the connector's own config
// shape.
export interface DaemonState<TConfig> {
    readonly automations: ReadonlyArray<{ id: string; enabled: boolean }>;
    readonly connectors: ReadonlyArray<{ id: string; config: TConfig }>;
}

export interface DaemonClient<TConfig> {
    readonly state: () => Promise<DaemonState<TConfig>>;
    readonly dispatch: (message: ListenerMessage) => Promise<void>;
    readonly dispatchStreaming: (message: ListenerMessage, onFrame: (frame: ListenerDispatchFrame) => void) => Promise<void>;
    readonly failure: (detail: string) => Promise<void>;
    readonly status: (snapshot: ListenerStatus) => Promise<void>;
}

export const createDaemonClient = <TConfig>(provider: string, base: string, token: string): DaemonClient<TConfig> => {
    const url = (path: string): string => `${base}/listeners/${provider}/${path}`;
    const jsonHeaders = { "content-type": "application/json", "x-intentic-panel": token };
    return {
        state: async () => {
            const res = await fetch(url("state"), { headers: { "x-intentic-panel": token } });
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
        failure: async (detail) => {
            await fetch(url("failure"), { method: "POST", headers: jsonHeaders, body: JSON.stringify({ detail }) }).catch(() => undefined);
        },
        status: async (snapshot) => {
            await fetch(url("status"), { method: "POST", headers: jsonHeaders, body: JSON.stringify(snapshot) }).catch(() => undefined);
        },
    };
};
