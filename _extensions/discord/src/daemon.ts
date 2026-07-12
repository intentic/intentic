// The gateway's client for the daemon's provider-scoped listener routes (app.ts / listener.routes.ts). The
// daemon holds no Discord connection itself — this process does — so every interaction with automations rides
// these four routes, authenticated with the per-boot panel token injected as INTENTIC_PANEL_TOKEN.

const PROVIDER = "discord";

export interface DiscordConnectorConfig {
    readonly provider: string;
    readonly botToken: string;
    readonly voiceModel?: string;
    readonly voiceLanguage?: string;
}

export interface DaemonState {
    readonly automations: ReadonlyArray<{ id: string; enabled: boolean }>;
    readonly connectors: ReadonlyArray<{ id: string; config: DiscordConnectorConfig }>;
}

// One ndjson frame the dispatch stream emits — a text delta for one automation's reply, or its terminal marker.
export interface DispatchFrame {
    readonly automationId: string;
    readonly delta?: string;
    readonly end?: boolean;
}

export interface DaemonClient {
    readonly state: () => Promise<DaemonState>;
    readonly dispatch: (message: object) => Promise<void>;
    readonly dispatchStreaming: (message: object, onFrame: (frame: DispatchFrame) => void) => Promise<void>;
    readonly failure: (detail: string) => Promise<void>;
    readonly status: (snapshot: object) => Promise<void>;
}

export const createDaemonClient = (base: string, token: string): DaemonClient => {
    const url = (path: string): string => `${base}/listeners/${PROVIDER}/${path}`;
    const jsonHeaders = { "content-type": "application/json", "x-intentic-panel": token };
    return {
        state: async () => {
            const res = await fetch(url("state"), { headers: { "x-intentic-panel": token } });
            if (!res.ok) {
                throw new Error(`/listeners/${PROVIDER}/state returned ${res.status}`);
            }
            return (await res.json()) as DaemonState;
        },
        dispatch: async (message) => {
            const res = await fetch(url("dispatch"), { method: "POST", headers: jsonHeaders, body: JSON.stringify(message) });
            await res.text();
            if (!res.ok) {
                throw new Error(`/listeners/${PROVIDER}/dispatch returned ${res.status}`);
            }
        },
        dispatchStreaming: async (message, onFrame) => {
            const res = await fetch(`${url("dispatch")}?stream=1`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(message) });
            if (!res.ok || res.body === null) {
                await res.text().catch(() => undefined);
                throw new Error(`/listeners/${PROVIDER}/dispatch?stream returned ${res.status}`);
            }
            const decoder = new TextDecoder();
            let buffer = "";
            const drain = (final: boolean): void => {
                let newline = buffer.indexOf("\n");
                while (newline >= 0) {
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + 1);
                    if (line !== "") {
                        onFrame(JSON.parse(line) as DispatchFrame);
                    }
                    newline = buffer.indexOf("\n");
                }
                if (final && buffer.trim() !== "") {
                    onFrame(JSON.parse(buffer.trim()) as DispatchFrame);
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
