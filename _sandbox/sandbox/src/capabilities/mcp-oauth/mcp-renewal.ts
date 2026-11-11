import type { Logger } from "pino";
import { opt } from "../../opt.js";
import type { CapabilitiesStore } from "../capabilities-store.js";
import { expiryOf, type TokenAnswer, tokenRequest, type TokenResult } from "./mcp-oauth-client.js";
import { encodeMcpSession, type McpSession, mcpSessionOf } from "./mcp-session.js";

// A signed-in MCP connection's bearer, kept fresh: renewed with its refresh token shortly before it lapses, or at once
// when its server has just refused it, and the renewed session written back over the one it came from. Whoever needs a
// bearer asks here (the turn's MCP door, mcp-remote.ts, and the card's status), so the agent never holds one that can
// lapse mid-turn.

// Renewed this long before it lapses, so a request sent with it is not refused in flight.
const RENEW_BEFORE_MS = 60_000;

// A connection's bearer as its MCP traffic needs it: the one to send (none for a server that takes none), or why there
// is none to send.
export type McpBearer =
    | { readonly bearer: string | undefined }
    // The saved sign-in no longer works and only a person signing in again fixes it.
    | { readonly signIn: string };

export interface RenewalDeps {
    readonly store: Pick<CapabilitiesStore, "get" | "upsert">;
    readonly logger: Pick<Logger, "warn">;
    readonly fetch: typeof fetch;
    readonly now: () => number;
}

// The session a token answer renews, keeping what the answer left out: a refresh token the server did not rotate, the
// scope it did not restate.
const renewed = (session: McpSession, tokens: TokenAnswer, now: number): McpSession => {
    const { expiresAt: _lapsed, ...rest } = session;
    return {
        ...rest,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? session.refreshToken,
        ...opt("expiresAt", expiryOf(tokens, now)),
        scope: tokens.scope ?? session.scope,
    };
};

const renew = async (deps: RenewalDeps, id: string, token: string, session: McpSession): Promise<McpBearer> => {
    if (session.refreshToken === undefined) {
        return { signIn: `${session.server} gave this sign-in no way to renew itself, and it has lapsed: sign in again.` };
    }
    let answer: TokenResult;
    try {
        answer = await tokenRequest(
            session,
            { grant_type: "refresh_token", refresh_token: session.refreshToken, resource: session.resource, ...opt("scope", session.scope) },
            deps.fetch,
        );
    } catch (error) {
        // Unreachable for now: the token in hand may still be honoured, and the next request tries again.
        deps.logger.warn({ err: error, capability: id }, `mcp sign-in: could not reach ${session.server} to renew, kept the current token`);
        return { bearer: session.accessToken };
    }
    if ("refused" in answer) {
        if (answer.final) {
            return { signIn: `${session.server} no longer accepts the saved sign-in (${answer.refused}): sign in again.` };
        }
        deps.logger.warn({ capability: id }, `mcp sign-in: ${session.server} did not renew (${answer.refused}), kept the current token`);
        return { bearer: session.accessToken };
    }
    const next = renewed(session, answer.tokens, deps.now());
    // Written over only the session it was renewed from: a sign-in or a pasted token that landed meanwhile wins.
    const latest = await deps.store.get(id);
    if (latest?.kind === "mcp" && latest.config.token === token) {
        await deps.store.upsert({ ...latest, config: { ...latest.config, token: encodeMcpSession(next) } });
    }
    return { bearer: next.accessToken };
};

export type BearerOf = (id: string, options?: { readonly force?: boolean }) => Promise<McpBearer>;

export const createBearers = (deps: RenewalDeps): BearerOf => {
    // One renewal per connection at a time: a refresh token is often single-use, so two at once would spend it twice.
    const renewing = new Map<string, Promise<McpBearer>>();
    return async (id, options = {}) => {
        const card = await deps.store.get(id);
        if (card?.kind !== "mcp") {
            return { bearer: undefined };
        }
        const token = card.config.token;
        const session = mcpSessionOf(token);
        if (session === undefined || token === undefined) {
            const pasted = token?.trim() ?? "";
            return { bearer: pasted === "" ? undefined : pasted };
        }
        const fresh = session.expiresAt === undefined || session.expiresAt - deps.now() > RENEW_BEFORE_MS;
        if (fresh && options.force !== true) {
            return { bearer: session.accessToken };
        }
        const running = renewing.get(id);
        if (running !== undefined) {
            return running;
        }
        const renewal = renew(deps, id, token, session).finally(() => renewing.delete(id));
        renewing.set(id, renewal);
        return renewal;
    };
};
