import { type KeyringSandboxKeys, KeyringSandboxKeysSchema } from "@intentic/sandbox-contract/schemas/keyring";

// A sandbox's keyring keys, fetched from its own address over TLS (GET /keyring/keys): the one source the keyring
// trusts for them, so a relay that swapped them in a share request would be talking past it. The address a device
// link dials may be a WebSocket one; the keys are served on the same host over HTTP(S).

const FETCH_TIMEOUT_MS = 10_000;

export const keysUrlOf = (sandbox: string): URL => {
    const url = new URL(sandbox);
    if (url.protocol === "wss:") {
        url.protocol = "https:";
    } else if (url.protocol === "ws:") {
        url.protocol = "http:";
    }
    return new URL("/keyring/keys", url.origin);
};

export const fetchSandboxKeys = async (sandbox: string, fetcher: typeof fetch = fetch): Promise<KeyringSandboxKeys> => {
    // No redirects: a key served from anywhere but the sandbox's own address is not the sandbox's.
    const response = await fetcher(keysUrlOf(sandbox), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error", headers: { accept: "application/json" } });
    if (!response.ok) {
        throw new Error(`it answered HTTP ${String(response.status)}`);
    }
    return KeyringSandboxKeysSchema.parse(await response.json());
};
