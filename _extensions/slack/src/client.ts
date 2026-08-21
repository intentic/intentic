import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

/* The gateway's Slack connections, one Socket Mode socket plus one Web API client per configured app, alive
 * only while the daemon says an enabled slack listener automation exists. A module singleton map, like
 * ext-discord's: the reconcile loop and the listener both reach it directly.
 *
 * Socket Mode is why this works in a sandbox at all: the connection is OUTBOUND, so Slack needs no public URL
 * to reach the agent and there is no request signature to verify. @slack/socket-mode owns the reconnect and
 * ping/pong lifecycle; what this file adds is the pool, the identity probe, and turning a start() rejection
 * into a sentence the owner can act on. */

export interface SlackConnection {
    readonly socket: SocketModeClient;
    readonly web: WebClient;
    // The bot's own user id, from auth.test at connect. Needed on every inbound message: it is how the listener
    // recognizes a mention (`<@id>`) and how it drops the bot's own posts instead of waking on them.
    readonly selfUserId: string;
}

// Keyed by the app token, which is what identifies one Slack app (and so one socket).
const connections = new Map<string, SlackConnection>();

export const slackConnection = (appToken: string): SlackConnection | undefined => connections.get(appToken);
export const slackConnections = (): ReadonlyMap<string, SlackConnection> => connections;

// Fatal: retrying with the same token and portal state can never succeed, so the caller pauses this token
// instead of hammering Slack. The message names the field the owner has to fix.
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
    // start() resolves on the `connected` frame and rejects on a refused handshake. Past that point the client
    // reconnects itself, so this await is the ONE place a bad app token can be diagnosed.
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

// Map a Slack auth rejection onto a message a user can act on. Slack's own codes for a dead credential
// (invalid_auth, not_authed, account_inactive, token_revoked, token_expired) are all fatal in the same way;
// anything else is a transient network/API failure the caller should simply retry.
const FATAL_CODES = ["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "team_disabled"];

const authFailure = (error: unknown, field: string, prefix: string): Error => {
    const message = error instanceof Error ? error.message : String(error);
    const code = FATAL_CODES.find((candidate) => message.includes(candidate));
    if (code !== undefined) {
        return new FatalSlackError(`Slack rejected the ${field} (${code}): paste a fresh ${prefix} token on the Slack capability`);
    }
    if (message.includes("missing_scope")) {
        return new FatalSlackError(`The Slack app is missing a required scope: reinstall it with the scopes the capability card lists (${message})`);
    }
    return error instanceof Error ? error : new Error(message);
};
