import type { ListenerDispatchFrame, ListenerMessage, ListenerStatus } from "@intentic/sandbox-contract";
import { EXTENSION_TOKEN_HEADER } from "@intentic/sandbox-contract/headers";
import { type ListenerState, listenerRouteUrl, ListenerStateSchema } from "@intentic/sandbox-contract/listener-protocol";
import type { Logger } from "./log.js";

// The gateway's client for the daemon's provider-scoped listener routes (app.ts / listener.routes.ts): the daemon holds
// no provider connection itself, so every automation interaction rides these four routes, authenticated with the
// extension's own INTENTIC_EXTENSION_TOKEN: the daemon answers them only for the extension whose manifest declares this
// provider as its listener. Paths, shapes and the state feed's schema come from the contract's listener-protocol, the
// same declaration the daemon serves from (the subpath, so a gateway loads no more of the contract than that).

// The reconcile feed /listeners/<provider>/state serves (the contract's ListenerState): enabled automations for this
// provider, plus the connector capabilities this extension contributes, with full config (secrets included, the gateway
// needs them). `TConfig` is the connector's own config shape, which the feed's schema leaves to the connector.
export type DaemonState<TConfig> = Omit<ListenerState, "connectors"> & {
    readonly connectors: ReadonlyArray<{ id: string; config: TConfig }>;
};

export interface DaemonClient<TConfig> {
    readonly state: () => Promise<DaemonState<TConfig>>;
    readonly dispatch: (message: ListenerMessage) => Promise<void>;
    readonly dispatchStreaming: (message: ListenerMessage, onFrame: (frame: ListenerDispatchFrame) => void) => Promise<void>;
    // Reports never reject: a connector fires them and moves on, so a report the daemon did not take is logged here.
    readonly failure: (detail: string) => Promise<void>;
    readonly status: (snapshot: ListenerStatus) => Promise<void>;
}

export const createDaemonClient = <TConfig>(provider: string, base: string, token: string, log: Logger): DaemonClient<TConfig> => {
    const url = (route: Parameters<typeof listenerRouteUrl>[0]): string => `${base}${listenerRouteUrl(route, provider)}`;
    const jsonHeaders = { "content-type": "application/json", [EXTENSION_TOKEN_HEADER]: token };
    const report = async (path: "failure" | "status", body: unknown, context: object): Promise<void> => {
        try {
            const res = await fetch(url(path), { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
            await res.text();
            if (!res.ok) {
                log.warn({ ...context, status: res.status }, `${listenerRouteUrl(path, provider)} returned ${res.status}`);
            }
        } catch (error) {
            log.warn({ ...context, err: error }, `${listenerRouteUrl(path, provider)} failed`);
        }
    };
    return {
        state: async () => {
            const res = await fetch(url("state"), { headers: { [EXTENSION_TOKEN_HEADER]: token } });
            if (!res.ok) {
                throw new Error(`${listenerRouteUrl("state", provider)} returned ${res.status}`);
            }
            // The schema checks the feed's frame; a connector's config is its own shape, read by the connector.
            return ListenerStateSchema.parse(await res.json()) as DaemonState<TConfig>;
        },
        dispatch: async (message) => {
            const res = await fetch(url("dispatch"), { method: "POST", headers: jsonHeaders, body: JSON.stringify(message) });
            await res.text();
            if (!res.ok) {
                throw new Error(`${listenerRouteUrl("dispatch", provider)} returned ${res.status}`);
            }
        },
        dispatchStreaming: async (message, onFrame) => {
            const res = await fetch(`${url("dispatch")}?stream=1`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(message) });
            if (!res.ok || res.body === null) {
                await res.text().catch(() => undefined);
                throw new Error(`${listenerRouteUrl("dispatch", provider)}?stream returned ${res.status}`);
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
