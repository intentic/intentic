import { errorMessage } from "@intentic/base/errors";
import type { McpAuthCheck, McpSignInStart } from "@intentic/sandbox-contract/schemas/mcp-sign-in";
import type { Logger } from "pino";
import { opt } from "../../opt.js";
import type { CapabilitiesStore } from "../capabilities-store.js";
import { discoverMcpAuth, type McpAuthDiscovery } from "./mcp-discovery.js";
import { accountOf, authorizeUrl, expiryOf, pkcePair, type RegisteredClient, registerClient, tokenRequest } from "./mcp-oauth-client.js";
import { type BearerOf, createBearers } from "./mcp-renewal.js";
import { createFlowBook, type Flow, type FlowEnd, type FlowOutcome } from "./mcp-sign-in-flows.js";
import { type McpSession, mcpSessionOf } from "./mcp-session.js";

// An MCP server's OAuth sign-in, run by the sandbox from start to finish except the person's approval, and the upkeep
// of what it yields. The browser is sent to the authorization server and lands back on this sandbox's own address
// (`GET /oauth/mcp/callback`, mcp-sign-in.routes.ts), which trades the code only for a sign-in started here: the state
// names it, the PKCE verifier never left this process, and a present `iss` must be the issuer it was started with
// (RFC 9207). The tokens become the connection's `token` as one session (mcp-session.ts), handed to the form as a stash
// marker, and are renewed on demand by whoever needs a bearer (mcp-renewal.ts).

// The path the authorization server sends the browser back to, on the sandbox's own address.
export const MCP_CALLBACK_PATH = "/oauth/mcp/callback";

// A refusal of the start, in the form's words: the route answers it as a bad request.
export class McpSignInRefusal extends Error {}

// What the browser is shown on landing; `ok` false is a page saying why, never a redirect anywhere.
export interface Landing {
    readonly ok: boolean;
    readonly message: string;
}

export interface McpSignInInput {
    readonly url: string;
    readonly clientId?: string | undefined;
    // The connection being edited, whose registered client is reused at the same authorization server.
    readonly keeping?: string | undefined;
}

export interface McpSignIns {
    readonly check: (url: string) => Promise<McpAuthCheck>;
    readonly begin: (input: McpSignInInput) => Promise<McpSignInStart>;
    readonly land: (query: URLSearchParams) => Promise<Landing>;
    readonly wait: (flow: string, signal?: AbortSignal) => Promise<FlowOutcome>;
    // The connection's current bearer, renewed first when it is about to lapse, or at once with `force`.
    readonly bearer: BearerOf;
}

export interface McpSignInsDeps {
    readonly store: Pick<CapabilitiesStore, "get" | "upsert">;
    // Where the browser comes back to: this sandbox's public address, or loopback for one that has none.
    readonly callbackBase: () => string;
    // How the authorization server's consent page names this client.
    readonly clientName: () => string;
    readonly logger: Pick<Logger, "warn">;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
}

const checkOf = (found: McpAuthDiscovery, redirectUri: string): McpAuthCheck => {
    switch (found.kind) {
        case "oauth":
            return { auth: "oauth", server: found.server, registers: found.metadata.registration_endpoint !== undefined, redirectUri };
        case "unreachable":
            return { auth: "unreachable", detail: found.detail };
        case "token":
            return { auth: "token", ...opt("detail", found.detail) };
        case "open":
            return { auth: "open" };
    }
};

const refusalOf = (found: Exclude<McpAuthDiscovery, { readonly kind: "oauth" }>): string => {
    if (found.kind === "unreachable") {
        return `Could not ask the server how to sign in: ${found.detail}`;
    }
    if (found.kind === "token" && found.detail !== undefined) {
        return found.detail;
    }
    return "This server names no sign-in: paste a token from its own settings instead";
};

// The client a connection being edited already registered, reused when it signed in at the same authorization server
// through the same callback: client credentials belong to the issuer that made them (the spec's server binding).
const keptClient = (session: McpSession | undefined, issuer: string, redirectUri: string): RegisteredClient | undefined =>
    session?.issuer === issuer && session.redirectUri === redirectUri
        ? { clientId: session.clientId, ...opt("clientSecret", session.clientSecret), clientAuth: session.clientAuth }
        : undefined;

// What answers a landing that cannot be acted on, checked before anything in it is read: the issuer (RFC 9207 §2.4,
// whose mismatch means its error is not even shown), then the authorization server's own refusal, then a missing code.
const landingProblem = (flow: Flow, query: URLSearchParams): string | undefined => {
    const iss = query.get("iss");
    if (iss === null ? flow.requireIss : iss !== flow.issuer) {
        return `The answer did not come from ${flow.server}, the authorization server this sign-in was started with. Sign in again.`;
    }
    const error = query.get("error");
    if (error === "access_denied") {
        return `The sign-in was cancelled at ${flow.server}.`;
    }
    if (error !== null || query.get("code") === null) {
        return `${flow.server} did not sign you in (${error ?? "it sent no code"}). Sign in again.`;
    }
    return undefined;
};

// The code traded for tokens, with the verifier only this daemon holds and the resource the sign-in is for. An
// unreachable token endpoint is a failed sign-in like a refused one, said apart.
const exchange = async (flow: Flow, code: string, fetchImpl: typeof fetch, now: () => number): Promise<FlowEnd> => {
    let answer: Awaited<ReturnType<typeof tokenRequest>>;
    try {
        answer = await tokenRequest(
            { ...flow.client, tokenEndpoint: flow.tokenEndpoint },
            { grant_type: "authorization_code", code, code_verifier: flow.verifier, redirect_uri: flow.redirectUri, resource: flow.resource },
            fetchImpl,
        );
    } catch (error) {
        return { state: "failed", message: `Could not reach ${flow.server} to finish the sign-in (${errorMessage(error)}). Sign in again.` };
    }
    if ("refused" in answer) {
        return { state: "failed", message: `${flow.server} would not finish the sign-in (${answer.refused}). Sign in again.` };
    }
    const { tokens } = answer;
    const session: McpSession = {
        mcpOAuth: 1,
        issuer: flow.issuer,
        server: flow.server,
        tokenEndpoint: flow.tokenEndpoint,
        ...flow.client,
        redirectUri: flow.redirectUri,
        resource: flow.resource,
        accessToken: tokens.access_token,
        ...opt("refreshToken", tokens.refresh_token),
        ...opt("expiresAt", expiryOf(tokens, now())),
        ...opt("scope", tokens.scope),
        ...opt("account", accountOf(tokens)),
    };
    return { state: "done", session };
};

export const createMcpSignIns = (deps: McpSignInsDeps): McpSignIns => {
    const fetchImpl = deps.fetch ?? fetch;
    const now = deps.now ?? Date.now;
    const flows = createFlowBook(now);
    const redirectUriOf = (): string => `${deps.callbackBase().replace(/\/+$/, "")}${MCP_CALLBACK_PATH}`;

    const clientFor = async (input: McpSignInInput, issuer: string, redirectUri: string, registration: string | undefined): Promise<RegisteredClient> => {
        if (input.clientId !== undefined) {
            return { clientId: input.clientId, clientAuth: "none" };
        }
        const editing = input.keeping === undefined ? undefined : await deps.store.get(input.keeping);
        const kept = keptClient(editing?.kind === "mcp" ? mcpSessionOf(editing.config.token) : undefined, issuer, redirectUri);
        if (kept !== undefined) {
            return kept;
        }
        const host = new URL(issuer).host;
        if (registration === undefined) {
            throw new McpSignInRefusal(
                `${host} does not register clients by itself: make an OAuth client in its own settings with ${redirectUri} as its redirect address, and enter its client ID`,
            );
        }
        const registered = await registerClient(registration, { redirectUri, clientName: deps.clientName() }, fetchImpl);
        if ("refused" in registered) {
            throw new McpSignInRefusal(`${host} refused to register this sandbox as a client (${registered.refused})`);
        }
        return registered.client;
    };

    const begin = async (input: McpSignInInput): Promise<McpSignInStart> => {
        const found = await discoverMcpAuth(input.url, fetchImpl);
        if (found.kind !== "oauth") {
            throw new McpSignInRefusal(refusalOf(found));
        }
        const { metadata } = found;
        const redirectUri = redirectUriOf();
        const client = await clientFor(input, metadata.issuer, redirectUri, metadata.registration_endpoint);
        const { verifier, challenge } = pkcePair();
        const flow = flows.open({
            verifier,
            issuer: metadata.issuer,
            requireIss: metadata.authorization_response_iss_parameter_supported === true,
            client,
            tokenEndpoint: metadata.token_endpoint,
            redirectUri,
            resource: found.resource,
            server: found.server,
        });
        const target = { clientId: client.clientId, redirectUri, state: flow.state, challenge, resource: found.resource, scope: found.scope };
        return { flow: flow.id, authorizeUrl: authorizeUrl(metadata.authorization_endpoint, target), redirectUri, server: found.server };
    };

    const land = async (query: URLSearchParams): Promise<Landing> => {
        // Nothing in an answer to a sign-in this sandbox did not start is acted on or repeated, its error included.
        const flow = flows.take(query.get("state") ?? "");
        if (flow === undefined) {
            return { ok: false, message: "This sign-in was not started here, or it already finished or lapsed. Go back to Intentic and sign in again." };
        }
        const problem = landingProblem(flow, query);
        const end: FlowEnd = problem === undefined ? await exchange(flow, query.get("code") ?? "", fetchImpl, now) : { state: "failed", message: problem };
        flows.finish(flow, end);
        return end.state === "done"
            ? { ok: true, message: `Signed in to ${flow.server}. You can close this window and go back to Intentic.` }
            : { ok: false, message: `${end.message} You can close this window.` };
    };

    return {
        check: async (url) => checkOf(await discoverMcpAuth(url, fetchImpl), redirectUriOf()),
        begin,
        land,
        wait: flows.wait,
        bearer: createBearers({ store: deps.store, logger: deps.logger, fetch: fetchImpl, now }),
    };
};
