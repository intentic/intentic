import { RELAY_CHANNEL_GONE } from "@intentic/sandbox-contract/schemas/push";

// One answer the relay's URL gives a send: its status and body.
export interface RelayAnswer {
    readonly status: number;
    readonly body: string;
}

// The relay's refusal as the platform's oRPC handler writes it (api push-relay.routes.ts): `error.toJSON()` as JSON, with
// the marker that forgets a channel on the three answers that end one, and without it otherwise.
export const relayRefusal = (status: number, code: string, gone: boolean): RelayAnswer => {
    const refusal = { defined: false, code, status, message: `the relay refused (${code})` };
    return { status, body: JSON.stringify(gone ? { ...refusal, data: { channel: RELAY_CHANNEL_GONE } } : refusal) };
};

// A proxy's own page in front of a platform that is down: what Cloudflare or a load balancer answers, never the relay.
export const proxyPage = (status: number): RelayAnswer => ({
    status,
    body: `<!DOCTYPE html><html><head><title>${status} | api.intentic.dev</title></head><body>Not Found</body></html>`,
});
