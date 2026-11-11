import { readFile } from "node:fs/promises";
import { DAEMON_PORT } from "@intentic/constants";
import type { AgentStoreOptions } from "./refresh-token.js";

// An hour of access token for a card signed in through the platform's own OAuth client (a field declaring `signIn`):
// the client secret a refresh needs stays on the platform, so the card's CLI and listener ask the daemon, which trades
// the card's refresh token there and answers with the access token alone. Two callers, one route, as with storing a
// sign-in: the agent's CLI presents the per-boot agent token; a listener process presents its own extension token and
// names `POST /capabilities/*/oauth-access` in its manifest's `permissions.daemon`.

export interface PlatformAccess {
    readonly accessToken: string;
    readonly expiresIn: number;
}

// The daemon or the platform refused. `reason` is the provider's own protocol code where it gave one (`invalid_grant`)
// or the daemon's sentence otherwise, for the CLI to put into what the owner does about it.
export class PlatformAccessRefused extends Error {
    constructor(
        readonly reason: string,
        readonly status: number,
    ) {
        super(reason);
    }
}

export const mintPlatformAccessAsAgent = async (id: string, options: AgentStoreOptions = {}): Promise<PlatformAccess> => {
    const env = options.env ?? process.env;
    const token = (await readFile(env["INTENTIC_AGENT_TOKEN_PATH"] ?? "/run/intentic/agent.token", "utf8")).trim();
    // The route as the contract declares it, never spelled here; loaded on first use, as storing a sign-in does.
    const { sandboxRequestFor } = await import("@intentic/sandbox-contract");
    const request = sandboxRequestFor(["capabilities", "oauthAccess"], { id });
    if (request === undefined) {
        throw new PlatformAccessRefused("this sandbox's daemon cannot refresh a platform sign-in: update the sandbox", 501);
    }
    const response = await (options.http ?? fetch)(`http://127.0.0.1:${env["SANDBOX_PORT"] ?? DAEMON_PORT}${request.path}`, {
        method: request.method,
        redirect: "error",
        signal: AbortSignal.timeout(45_000),
        headers: { "content-type": "application/json", "x-intentic-agent": token, "x-intentic-conversation": env["INTENTIC_TURN_OWNER"] ?? "" },
        body: JSON.stringify({}),
    });
    // allow(silent-catch): an unreadable answer is judged by its status alone.
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
        // A refusal's sentence as oRPC writes it (`{ code, status, message }`), or the bare status when the body has none.
        const said = body instanceof Object && "message" in body ? String(body.message) : `the daemon answered HTTP ${response.status}`;
        throw new PlatformAccessRefused(said, response.status);
    }
    const { CapabilityAccessTokenSchema } = await import("@intentic/sandbox-contract/schemas/capabilities");
    const access = CapabilityAccessTokenSchema.safeParse(body);
    if (!access.success) {
        throw new PlatformAccessRefused("the daemon answered without an access token", 502);
    }
    return access.data;
};

// The one daemon call a listener process makes for it; its `api` (ExtensionProcessApi) is one.
export interface PlatformAccessDaemon {
    readonly daemon: {
        readonly rpc: { readonly capabilities: { readonly oauthAccess: (input: { readonly id: string }) => Promise<PlatformAccess> } };
    };
}

export const mintPlatformAccessAsExtension = async (api: PlatformAccessDaemon, id: string): Promise<PlatformAccess> => {
    try {
        return await api.daemon.rpc.capabilities.oauthAccess({ id });
    } catch (error) {
        // The typed client's refusals are oRPC errors carrying the status they were refused with; anything else
        // (the daemon unreachable) has none and is rethrown as it is.
        if (error instanceof Error && "status" in error && Number.isInteger(error.status)) {
            throw new PlatformAccessRefused(error.message, Number(error.status));
        }
        throw error;
    }
};
