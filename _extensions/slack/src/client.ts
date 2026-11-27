import { errorMessage } from "@intentic/base/errors";
import { SocketModeClient } from "@slack/socket-mode";
import { WebAPIPlatformError, WebClient } from "@slack/web-api";

// One Web API client per configured Slack app, and how Slack reaches it, alive while the daemon reports an enabled
// listener automation; a module singleton reached by the reconcile loop and the listener. Slack reaches the sandbox one
// of two ways (2026-11-27): Socket Mode's outbound WebSocket, which needs no public URL but is heard only while the
// sandbox runs, or HTTP mode, Slack POSTing to the app's Request URL (http.ts), which a sandbox the platform hosts needs,
// since it sleeps when nobody uses it and a request at its wake URL wakes it. This file adds the pool, the identity
// probe, and an actionable message for a failed start(); which mode a card's app is in is mode.ts's.

// How Slack reaches one app: its socket, or the signing secret its Request URL's calls are checked against.
export type SlackInbound = { readonly mode: "socket"; readonly socket: SocketModeClient } | { readonly mode: "http"; readonly signingSecret: string };

export interface SlackConnection {
    // The Slack card this connection serves (its capability id), which keys it in the pool.
    readonly id: string;
    readonly inbound: SlackInbound;
    readonly web: WebClient;
    // Bot's own user id (from auth.test); how the listener recognizes a mention and ignores its own posts.
    readonly selfUserId: string;
}

// Keyed by the card's id.
const connections = new Map<string, SlackConnection>();

export const slackConnection = (id: string): SlackConnection | undefined => connections.get(id);
export const slackConnections = (): ReadonlyMap<string, SlackConnection> => connections;

// Fatal: retrying with the same token can never succeed; the caller should pause this token rather than retry. Message
// names the field to fix.
export class FatalSlackError extends Error {}

// What opening a connection is handed: the bot token, and the app-level token or the signing secret its mode needs.
export type SlackOpening = { readonly mode: "socket"; readonly appToken: string } | { readonly mode: "http"; readonly signingSecret: string };

export const openSlackConnection = async (id: string, botToken: string, opening: SlackOpening): Promise<SlackConnection> => {
    const web = new WebClient(botToken);
    const identity = await web.auth.test().catch((error: unknown) => {
        throw authFailure(error, "botToken", "xoxb-");
    });
    const selfUserId = identity.user_id;
    if (selfUserId === undefined) {
        throw new FatalSlackError("Slack accepted the bot token but returned no bot user: reinstall the app to your workspace");
    }
    const inbound: SlackInbound = opening.mode === "http" ? { mode: "http", signingSecret: opening.signingSecret } : { mode: "socket", socket: await openSocket(opening.appToken) };
    const connection: SlackConnection = { id, inbound, web, selfUserId };
    connections.set(id, connection);
    return connection;
};

// Resolves on `connected`, rejects on a refused handshake; past this point the client reconnects itself, so this is the
// only place to catch a bad app token.
const openSocket = async (appToken: string): Promise<SocketModeClient> => {
    const socket = new SocketModeClient({ appToken });
    try {
        await socket.start();
    } catch (error) {
        // allow(silent-catch): the refused handshake is the failure to report; closing is only tidying up after it.
        await socket.disconnect().catch(() => undefined);
        throw authFailure(error, "appToken", "xapp-");
    }
    return socket;
};

export const closeSlackConnection = async (id: string): Promise<void> => {
    const connection = connections.get(id);
    if (connection === undefined) {
        return;
    }
    connections.delete(id);
    if (connection.inbound.mode === "socket") {
        // allow(silent-catch): a socket that will not close cleanly is gone from the pool already, and holds nothing.
        await connection.inbound.socket.disconnect().catch(() => undefined);
    }
};

// The code Slack answered a call with ("already_reacted", "not_allowed"), for a call Slack itself refused. Read off the
// answer rather than the SDK's sentence around it; socket.start() throws the same error for apps.connections.open.
export const slackErrorCode = (error: Error): string | undefined => (error instanceof WebAPIPlatformError ? error.data.error : undefined);

// Slack's dead-credential codes are always fatal (user_removed_from_team is one Socket Mode also gives up on); anything
// else is a transient failure to retry.
const FATAL_CODES = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "team_disabled", "user_removed_from_team"]);

export const authFailure = (error: unknown, field: string, prefix: string): Error => {
    const code = error instanceof Error ? slackErrorCode(error) : undefined;
    if (code !== undefined && FATAL_CODES.has(code)) {
        return new FatalSlackError(`Slack rejected the ${field} (${code}): paste a fresh ${prefix} token on the Slack capability`);
    }
    if (code === "missing_scope") {
        return new FatalSlackError(`The Slack app is missing a required scope: reinstall it with the scopes the capability card lists (${errorMessage(error)})`);
    }
    return error instanceof Error ? error : new Error(errorMessage(error));
};
