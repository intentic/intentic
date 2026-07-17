// The gateway's client for the daemon's provider-scoped listener routes (app.ts / listener.routes.ts). The
// daemon holds no IMAP connection itself — this process does — so every interaction with automations rides
// these four routes, authenticated with the per-boot panel token injected as INTENTIC_PANEL_TOKEN. Unlike the
// discord gateway there is no streaming dispatch: nothing paints a reply back into a mailbox (that would be
// SMTP), so events are plain fire-and-forget dispatches.

const PROVIDER = "imap";

export interface ImapConnectorConfig {
    readonly provider: string;
    readonly host: string;
    readonly port: string;
    readonly username: string;
    readonly password: string;
    readonly mailbox?: string;
}

export interface DaemonState {
    readonly automations: ReadonlyArray<{ id: string; enabled: boolean }>;
    readonly connectors: ReadonlyArray<{ id: string; config: ImapConnectorConfig }>;
}

export interface DaemonClient {
    readonly state: () => Promise<DaemonState>;
    readonly dispatch: (message: object) => Promise<void>;
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
        failure: async (detail) => {
            await fetch(url("failure"), { method: "POST", headers: jsonHeaders, body: JSON.stringify({ detail }) }).catch(() => undefined);
        },
        status: async (snapshot) => {
            await fetch(url("status"), { method: "POST", headers: jsonHeaders, body: JSON.stringify(snapshot) }).catch(() => undefined);
        },
    };
};
