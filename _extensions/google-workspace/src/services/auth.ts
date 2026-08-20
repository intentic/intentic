import { createServer } from "node:http";
import { flag, required } from "../cli/args.js";
import { type Command, type CommandGroup, type RootCommand, printJson } from "../cli/command.js";
import { row } from "../cli/format.js";
import { describe } from "../google/accounts.js";
import { call } from "../google/request.js";
import { scopesFor } from "../google/scopes.js";
import { exchangeCode } from "../google/token.js";

const CONSENT = "https://accounts.google.com/o/oauth2/v2/auth";
// A fixed port so the redirect URI printed by `login` is the one `exchange` assumes, and so an owner who has
// to register it by hand registers it once.
const DEFAULT_PORT = 9004;
const WAIT_MS = 5 * 60 * 1000;

const redirectUri = (port: number): string => `http://127.0.0.1:${port}`;

const consentUrl = (clientId: string, port: number, scopes: readonly string[]): string =>
    `${CONSENT}?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri(port),
        response_type: "code",
        scope: scopes.join(" "),
        // Without both of these Google issues no refresh token on a client that has been approved before, and
        // a refresh token is the entire point of this flow.
        access_type: "offline",
        prompt: "consent",
    }).toString()}`;

// A pasted `http://127.0.0.1:9004/?code=…&scope=…` is what an owner who approved in their OWN browser has in
// front of them, the redirect failed to connect, but the address bar holds the answer. Both that and a bare
// code are accepted, because which one arrives depends on whose browser it was.
const codeFrom = (input: string): string => {
    const value = input.trim();
    if (!value.includes("://")) {
        return value;
    }
    const code = new URL(value).searchParams.get("code");
    if (code === null) {
        throw new Error("That URL carries no ?code= — copy the whole address the browser landed on after you approved.");
    }
    return code;
};

const waitForCode = async (port: number): Promise<string | undefined> =>
    new Promise((resolve) => {
        const server = createServer((request, response) => {
            const code = new URL(request.url ?? "/", redirectUri(port)).searchParams.get("code");
            response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            response.end(code === null ? "No code in that request." : "Done — you can close this tab and go back to the chat.");
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
        // The timer must not be what keeps the process alive once the code has landed.
        timer.unref();
    });

const login: RootCommand = {
    name: "login",
    summary: "Walk through Google's consent and print a refresh token to paste onto the card",
    usage: "gw auth login --client-id … --client-secret … [--access read] [--port 9004]",
    run: async (ctx) => {
        const clientId = required(ctx.args, "client-id");
        const clientSecret = required(ctx.args, "client-secret");
        const port = Number.parseInt(flag(ctx.args, "port") ?? String(DEFAULT_PORT), 10);
        const scopes = scopesFor(flag(ctx.args, "access") === "read" ? "read" : "write");
        ctx.out("Open this and approve it:");
        ctx.out("");
        ctx.out(consentUrl(clientId, port, scopes));
        ctx.out("");
        ctx.out(`The OAuth client must be a "Desktop app" client, or a Web client with ${redirectUri(port)} as an authorized redirect URI.`);
        ctx.out("Approving in THIS sandbox's browser finishes it here. Approving in your own browser lands on a page that cannot load —");
        ctx.out(`copy that address and run: gw auth exchange --client-id … --client-secret … --code "<the whole URL>"`);
        ctx.out("");
        const code = await waitForCode(port);
        if (code === undefined) {
            ctx.out("Nothing arrived on the loopback — use the exchange command above with the address the browser landed on.");
            return;
        }
        const { refreshToken, scopes: granted } = await exchangeCode(clientId, clientSecret, code, redirectUri(port));
        ctx.out("Paste this as the Refresh token on the Google Workspace card:");
        ctx.out(refreshToken);
        ctx.out(`(granted: ${granted})`);
    },
};

const exchange: RootCommand = {
    name: "exchange",
    summary: "Turn an authorization code into a refresh token",
    usage: 'gw auth exchange --client-id … --client-secret … --code "<code or the whole redirect URL>" [--port 9004]',
    run: async (ctx) => {
        const port = Number.parseInt(flag(ctx.args, "port") ?? String(DEFAULT_PORT), 10);
        const { refreshToken, scopes } = await exchangeCode(
            required(ctx.args, "client-id"),
            required(ctx.args, "client-secret"),
            codeFrom(required(ctx.args, "code")),
            redirectUri(port),
        );
        ctx.out("Paste this as the Refresh token on the Google Workspace card:");
        ctx.out(refreshToken);
        ctx.out(`(granted: ${scopes})`);
    },
};

const token: Command = {
    name: "token",
    summary: "Mint an access token — for checking a connection works, not for storing",
    usage: "gw auth token [--account name]",
    run: async (ctx) => {
        const value = await ctx.session.token();
        // tokeninfo is a convenience, not the answer: a token that works but whose introspection is refused
        // must still report the account it belongs to.
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
