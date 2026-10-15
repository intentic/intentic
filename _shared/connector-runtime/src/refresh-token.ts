import { readFile } from "node:fs/promises";

// A delegated OAuth sign-in's refresh token, stored on its card through the daemon's oauth-token route (a card whose
// manifest declares `refreshToken`), rather than printed for someone to paste. Two callers, one route: the agent's CLI,
// which presents the per-boot agent token every agent-side CLI carries, and a listener process, which presents its own
// extension token and names the route in its manifest's `permissions.daemon`. The daemon writes only the declared
// field, and only for a caller holding the card's current token while the card still holds what the sign-in was made
// against.

export interface RefreshTokenWrite {
    // The card, by its id or by the id its env suffix spells.
    readonly id: string;
    // The card's settings the sign-in was made against, by field key.
    readonly binding: Readonly<Record<string, string>>;
    // The token this process held: empty before the card's first sign-in.
    readonly previous: string;
    readonly refreshToken: string;
    // An interactive sign-in rather than a rotation: restarts the card's listener.
    readonly login?: boolean;
}

// `superseded`: the card already holds a newer token than `previous`, because another process rotated first. Microsoft
// keeps each refresh token it issued valid until it expires, so the caller carries on with its own.
export type RefreshTokenStored = "stored" | "superseded";

const CONFLICT = 409;

export interface AgentStoreOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly http?: (url: string, init: RequestInit) => Promise<Response>;
}

export const storeRefreshTokenAsAgent = async (write: RefreshTokenWrite, options: AgentStoreOptions = {}): Promise<RefreshTokenStored> => {
    const env = options.env ?? process.env;
    const token = (await readFile(env["INTENTIC_AGENT_TOKEN_PATH"] ?? "/run/intentic/agent.token", "utf8")).trim();
    // The route as the contract declares it, never spelled here. Loaded on the first store only: the contract holds
    // every schema the daemon has, which a CLI command that stores nothing should not pay for.
    const { sandboxRequestFor } = await import("@intentic/sandbox-contract");
    const request = sandboxRequestFor(["capabilities", "oauthToken"], { id: write.id });
    if (request === undefined) {
        throw new Error("this sandbox's daemon cannot store a sign-in on a card: update the sandbox");
    }
    const response = await (options.http ?? fetch)(`http://127.0.0.1:${env["SANDBOX_PORT"] ?? "8787"}${request.path}`, {
        method: request.method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/json", "x-intentic-agent": token, "x-intentic-conversation": env["INTENTIC_TURN_OWNER"] ?? "" },
        body: JSON.stringify({ binding: write.binding, previous: write.previous, refreshToken: write.refreshToken, login: write.login === true }),
    });
    if (response.status === CONFLICT && write.previous !== "" && write.login !== true) {
        return "superseded";
    }
    if (!response.ok) {
        throw new Error(`the daemon did not store the sign-in on the card (${response.status}): sign in again from a turn you started`);
    }
    return "stored";
};

// The one daemon call a listener process makes here; its `api` (ExtensionProcessApi) is one.
export interface RefreshTokenDaemon {
    readonly daemon: {
        readonly rpc: { readonly capabilities: { readonly oauthToken: (input: RefreshTokenWrite) => Promise<{ readonly ok: true }> } };
    };
}

export const storeRefreshTokenAsExtension = async (api: RefreshTokenDaemon, write: RefreshTokenWrite): Promise<RefreshTokenStored> => {
    try {
        await api.daemon.rpc.capabilities.oauthToken({ ...write, login: write.login === true });
        return "stored";
    } catch (error) {
        // SAFETY: the typed client's refusals are ORPC errors carrying the HTTP status they were refused with; anything
        // else has no `status` and is rethrown.
        if ((error as { status?: number }).status === CONFLICT && write.previous !== "" && write.login !== true) {
            return "superseded";
        }
        throw error;
    }
};
