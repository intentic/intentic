import { errorMessage } from "@intentic/base/errors";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

// One Socket Mode socket + Web API client per configured Slack app, alive while the daemon reports an enabled listener
// automation; a module singleton reached by the reconcile loop and the listener. Socket Mode's outbound connection
// needs no public URL; this file adds the pool, identity probe, and an actionable message for a failed start().

export interface SlackConnection {
    readonly socket: SocketModeClient;
    readonly web: WebClient;
    // Bot's own user id (from auth.test); how the listener recognizes a mention and ignores its own posts.
    readonly selfUserId: string;
}

// Keyed by the app token, which is what identifies one Slack app (and so one socket).
const connections = new Map<string, SlackConnection>();

export const slackConnection = (appToken: string): SlackConnection | undefined => connections.get(appToken);
export const slackConnections = (): ReadonlyMap<string, SlackConnection> => connections;

// Fatal: retrying with the same token can never succeed; the caller should pause this token rather than retry. Message
// names the field to fix.
export class FatalSlackError extends Error {}

export const openSlackConnection = async (appToken: string, botToken: string): Promise<SlackConnection> => {
    const web = new WebClient(botToken);
    const identity = await web.auth.test().catch((error: unknown) => {
        throw authFailure(error, "botToken", "xoxb-");
    });
    const selfUserId = identity.user_id;
    if (selfUserId === undefined) {
        throw new FatalSlackError("Slack accepted the bot token but returned no bot user: reinstall the app to your workspace");
    }
    const socket = new SocketModeClient({ appToken });
    // Resolves on `connected`, rejects on a refused handshake; past this point the client reconnects itself, so this is
    // the only place to catch a bad app token.
    await socket.start().catch(async (error: unknown) => {
        await socket.disconnect().catch(() => undefined);
        throw authFailure(error, "appToken", "xapp-");
    });
    const connection: SlackConnection = { socket, web, selfUserId };
    connections.set(appToken, connection);
    return connection;
};

export const closeSlackConnection = async (appToken: string): Promise<void> => {
    const connection = connections.get(appToken);
    if (connection === undefined) {
        return;
    }
    connections.delete(appToken);
    await connection.socket.disconnect().catch(() => undefined);
};

// Slack's dead-credential codes are always fatal; anything else is a transient failure to retry.
const FATAL_CODES = ["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "team_disabled"];

const authFailure = (error: unknown, field: string, prefix: string): Error => {
    const message = errorMessage(error);
    const code = FATAL_CODES.find((candidate) => message.includes(candidate));
    if (code !== undefined) {
        return new FatalSlackError(`Slack rejected the ${field} (${code}): paste a fresh ${prefix} token on the Slack capability`);
    }
    if (message.includes("missing_scope")) {
        return new FatalSlackError(`The Slack app is missing a required scope: reinstall it with the scopes the capability card lists (${message})`);
    }
    return error instanceof Error ? error : new Error(message);
};
