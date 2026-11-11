import { createServer } from "node:http";
import { storeRefreshTokenAsAgent } from "@intentic/connector-runtime";
import { envSuffix } from "@intentic/sandbox-contract/policy/capability-env";
import { flag, required } from "../cli/args.js";
import { type Command, type CommandGroup, type RootCommand, type RootContext, printJson } from "../cli/command.js";
import { row } from "../cli/format.js";
import { type Connection, describe, selectConnection } from "../google/accounts.js";
import { call } from "../google/request.js";
import { scopesFor } from "../google/scopes.js";
import { exchangeCode } from "../google/token.js";

const CONSENT = "https://accounts.google.com/o/oauth2/v2/auth";
// Fixed so the redirect URI `login` prints is the one `exchange` assumes, registered by hand once.
const DEFAULT_PORT = 9004;
const WAIT_MS = 5 * 60 * 1000;

const redirectUri = (port: number): string => `http://127.0.0.1:${port}`;

const consentUrl = (clientId: string, port: number, scopes: readonly string[]): string =>
    `${CONSENT}?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri(port),
        response_type: "code",
        scope: scopes.join(" "),
        // Without both, Google issues no refresh token on a client approved before, the entire point of this flow.
        access_type: "offline",
        prompt: "consent",
    }).toString()}`;

// Accepts either a bare code or a full redirect URL, since an owner approving in their own browser lands on a page that
// failed to connect but still carries `?code=` in the address bar.
const codeFrom = (input: string): string => {
    const value = input.trim();
    if (!value.includes("://")) {
        return value;
    }
    const code = new URL(value).searchParams.get("code");
    if (code === null) {
        throw new Error("That URL carries no ?code=: copy the whole address the browser landed on after you approved.");
    }
    return code;
};

const waitForCode = async (port: number): Promise<string | undefined> =>
    new Promise((resolve) => {
        const server = createServer((request, response) => {
            const code = new URL(request.url ?? "/", redirectUri(port)).searchParams.get("code");
            response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            response.end(code === null ? "No code in that request." : "Done, you can close this tab and go back to the chat.");
            if (code !== null) {
                server.close();
                resolve(code);
            }
        });
        server.on("error", () => resolve(undefined));
        server.listen(port, "127.0.0.1");
        const timer = setTimeout(() => {
            server.close();
            resolve(undefined);
        }, WAIT_MS);
        // Must not be what keeps the process alive once the code has already landed.
        timer.unref();
    });

// The card a sign-in on the owner's own OAuth client is for, with that client: `--account` names the card when several
// are connected, and the client comes off the card itself unless flags name one. A card with no client of its own was
// signed in with Connect Google, which this command has nothing to add to.
interface OwnClientCard {
    readonly connection: Connection;
    readonly clientId: string;
    readonly clientSecret: string;
}

const cardEnv = (connection: Connection, key: string): string => (process.env[`${key}_${envSuffix(connection.name)}`] ?? "").trim();

const ownClientCard = (ctx: RootContext): OwnClientCard => {
    const connection = selectConnection(
        ctx.connections.filter((candidate) => candidate.mode === "user"),
        flag(ctx.args, "account"),
    );
    const clientId = flag(ctx.args, "client-id") ?? cardEnv(connection, "GOOGLE_CLIENT_ID");
    const clientSecret = flag(ctx.args, "client-secret") ?? cardEnv(connection, "GOOGLE_CLIENT_SECRET");
    if (clientId === "" || clientSecret === "") {
        throw new Error(
            `"${describe(connection)}" has no OAuth client of its own: it signs in with the Connect Google button on its card under Capabilities. This command is for a card with your own client ID and secret (its Advanced section).`,
        );
    }
    return { connection, clientId, clientSecret };
};

// Stores the new refresh token on the card through the daemon, never printing it: a long-lived credential in a
// transcript is exactly what this flow replaced.
const storeOnCard = async (ctx: RootContext, card: OwnClientCard, refreshToken: string, granted: string): Promise<void> => {
    await storeRefreshTokenAsAgent({
        id: card.connection.name,
        binding: { mode: "user", clientId: card.clientId },
        previous: cardEnv(card.connection, "GOOGLE_REFRESH_TOKEN"),
        refreshToken,
        login: true,
    });
    ctx.out(`Signed in: "${describe(card.connection)}" now holds the new grant (the next gw command picks it up).`);
    ctx.out(`(granted: ${granted})`);
};

const login: RootCommand = {
    name: "login",
    summary: "Sign a card with your own OAuth client in to Google, storing the grant on the card",
    usage: "gw auth login [--account name] [--client-id … --client-secret …] [--access read] [--port 9004]",
    run: async (ctx) => {
        const card = ownClientCard(ctx);
        const port = Number.parseInt(flag(ctx.args, "port") ?? String(DEFAULT_PORT), 10);
        const scopes = scopesFor((flag(ctx.args, "access") ?? card.connection.access) === "read" ? "read" : "write");
        ctx.out("Open this and approve it:");
        ctx.out("");
        ctx.out(consentUrl(card.clientId, port, scopes));
        ctx.out("");
        ctx.out(`The OAuth client must be a "Desktop app" client, or a Web client with ${redirectUri(port)} as an authorized redirect URI.`);
        ctx.out("Approving in THIS sandbox's browser finishes it here. Approving in your own browser lands on a page that cannot load —");
        ctx.out(`copy that address and run: gw auth exchange --account ${card.connection.name} --code "<the whole URL>"`);
        ctx.out("");
        const code = await waitForCode(port);
        if (code === undefined) {
            ctx.out("Nothing arrived on the loopback: use the exchange command above with the address the browser landed on.");
            return;
        }
        const { refreshToken, scopes: granted } = await exchangeCode(card.clientId, card.clientSecret, code, redirectUri(port));
        await storeOnCard(ctx, card, refreshToken, granted);
    },
};

const exchange: RootCommand = {
    name: "exchange",
    summary: "Finish a login approved in another browser, storing the grant on the card",
    usage: 'gw auth exchange [--account name] [--client-id … --client-secret …] --code "<code or the whole redirect URL>" [--port 9004]',
    run: async (ctx) => {
        const card = ownClientCard(ctx);
        const port = Number.parseInt(flag(ctx.args, "port") ?? String(DEFAULT_PORT), 10);
        const { refreshToken, scopes } = await exchangeCode(card.clientId, card.clientSecret, codeFrom(required(ctx.args, "code")), redirectUri(port));
        await storeOnCard(ctx, card, refreshToken, scopes);
    },
};

const token: Command = {
    name: "token",
    summary: "Mint an access token, for checking a connection works, not for storing",
    usage: "gw auth token [--account name]",
    run: async (ctx) => {
        const value = await ctx.session.token();
        // tokeninfo is a convenience; a token that works but refuses introspection must still report its account.
        const info: { scope?: string; expires_in?: number } = await call<{ scope?: string; expires_in?: number }>(ctx.session, {
            url: "https://www.googleapis.com/oauth2/v3/tokeninfo",
            query: { access_token: value },
        }).catch(() => ({}));
        ctx.out(row(describe(ctx.connection), `expires in ${info.expires_in ?? "?"}s`));
        ctx.out(info.scope ?? "(scopes unknown)");
    },
};

export const accountsCommand: RootCommand = {
    name: "accounts",
    summary: "The Google accounts this agent can act as",
    usage: "gw accounts",
    run: async (ctx) => {
        if (ctx.json) {
            printJson(
                ctx,
                ctx.connections.map(({ name, email, mode, access, problem }) => ({ name, email, mode, access, problem })),
            );
            return;
        }
        if (ctx.connections.length === 0) {
            ctx.out("No Google account is connected. Add the Google Workspace card under Capabilities.");
            return;
        }
        for (const connection of ctx.connections) {
            ctx.out(
                row(
                    connection.name,
                    connection.email,
                    connection.mode === "domain" ? "company service account" : "personal grant",
                    connection.access === "read" ? "READ ONLY" : "read & write",
                    connection.problem === undefined ? undefined : `⚠ ${connection.problem}`,
                ),
            );
        }
    },
};

export const whoamiCommand: Command = {
    name: "whoami",
    summary: "Which account a command would use, and whether it works",
    usage: "gw whoami [--account name]",
    run: async (ctx) => {
        const profile = await call<{ emailAddress?: string; messagesTotal?: number }>(ctx.session, {
            url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        });
        ctx.out(
            row(
                ctx.connection.name,
                profile.emailAddress ?? ctx.connection.email,
                ctx.connection.mode === "domain" ? "company service account" : "personal grant",
                ctx.connection.access === "read" ? "READ ONLY" : "read & write",
                `${profile.messagesTotal ?? "?"} messages in the mailbox`,
            ),
        );
    },
};

export const authGroup: CommandGroup = {
    name: "auth",
    summary: "Connect an account, or check the one connected",
    commands: [token],
    rootCommands: [login, exchange],
};
