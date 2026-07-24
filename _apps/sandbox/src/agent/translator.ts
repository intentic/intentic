import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { KeyedProvider } from "@intentic/sandbox-contract";
import type { Config } from "../env.config.js";
import type { Services } from "../composition.js";

/* The bundled translator is CLIProxyAPI: a Go proxy that lets the Claude Code harness — which speaks only the
 * Anthropic Messages API — drive OpenAI (Codex), xAI (Grok) and Google (Gemini) models on the user's
 * SUBSCRIPTION. CLIProxyAPI holds each provider's subscription OAuth in its auth-dir and re-serves it behind an
 * Anthropic-compatible endpoint; a routed turn (streamAgent) points ANTHROPIC_BASE_URL at config.translator.url
 * with config.translator.token as the bearer, and the model id selects the upstream provider.
 *
 * The binary is baked into the sandbox image (see the Dockerfile). On a bare `tsx watch` dev run TRANSLATOR_URL
 * is empty and startTranslator is a no-op — routed turns then surface streamAgent's clean "no translator" error.
 * The config is static (port + auth-dir + the local bearer); accounts are added/removed at runtime through the
 * Management API (see createCliProxyClient), so no config reconverge/restart is needed on a connect. */

// CLIProxyAPI's provider ids for the routed providers. Only `codex` matches ours: the app says "grok" where
// CLIProxyAPI says "xai", and "gemini" where it says "antigravity" — Antigravity is Google's own agent product,
// and its channel is the one CLIProxyAPI serves Gemini models on from a plain Google-account sign-in. The app
// surfaces the model the user picks, not the Google product that vends it.
const CLIPROXY_PROVIDER: Record<KeyedProvider, string> = { codex: "codex", grok: "xai", gemini: "antigravity" };

// The subscription-token store (survives sandbox rebuilds alongside the other AI-provider credentials).
const cliProxyAuthDir = (authRoot: string): string => join(authRoot, "cliproxy");
// The rendered server config (on /history, outside the agent's reach); the login subprocess shares it via --config.
export const cliProxyConfigPath = (config: Config): string => join(config.historyRoot, "translator", "config.yaml");
// The Management API base (localhost-only) on the same port that serves the Anthropic endpoint.
export const cliProxyManagementUrl = (config: Config): string => `${config.translator.url.replace(/\/$/, "")}/v0/management`;

// A localhost-bound CLIProxyAPI serving the Anthropic endpoint (api-keys) + the Management API (secret-key). Both
// accept the same fixed local bearer — the port is loopback-only.
const renderConfig = (opts: { port: number; authDir: string; token: string }): string =>
    [
        `host: "127.0.0.1"`,
        `port: ${opts.port}`,
        `auth-dir: ${JSON.stringify(opts.authDir)}`,
        `api-keys:`,
        `  - ${JSON.stringify(opts.token)}`,
        `remote-management:`,
        `  allow-remote: false`,
        `  secret-key: ${JSON.stringify(opts.token)}`,
        ``,
    ].join("\n");

const portOf = (url: string): number | undefined => {
    try {
        const parsed = new URL(url);
        return parsed.port !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    } catch {
        return undefined;
    }
};

// Start the CLIProxyAPI server and keep it alive. Best-effort and non-throwing: a routed turn that finds it down
// surfaces its own error. Returns immediately; the proxy runs for the daemon's lifetime. No-op when no translator
// is baked (config.translator.url empty — the dev path).
export const startTranslator = (services: Services): void => {
    const { config, authRoot, logger } = services;
    if (config.translator.url === "") {
        return;
    }
    const port = portOf(config.translator.url);
    if (port === undefined) {
        logger.warn({ url: config.translator.url }, "translator: unparseable TRANSLATOR_URL — not starting");
        return;
    }
    const authDir = cliProxyAuthDir(authRoot);
    const configPath = cliProxyConfigPath(config);
    let child: ChildProcess | undefined;

    const start = async (): Promise<void> => {
        await mkdir(authDir, { recursive: true });
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, renderConfig({ port, authDir, token: config.translator.token }), { mode: 0o600 });
        child = spawn("cli-proxy-api", ["--config", configPath], { stdio: "ignore", env: process.env });
        child.on("exit", (code) => {
            child = undefined;
            logger.warn({ code }, "translator: cli-proxy-api exited — restarting in 5s");
            setTimeout(() => void start().catch((error: unknown) => logger.warn({ err: error }, "translator restart failed")), 5_000);
        });
    };

    void start().catch((error: unknown) => logger.warn({ err: error }, "translator: initial start failed"));
};

// The CLIProxyAPI Management API client + login orchestration the /translator routes and the routed-turn gate
// use. `accounts` reads the connected-subscription set; `connect` starts a provider's login and returns what the
// card shows; `complete` finishes the one provider whose login can't self-complete (see below); `disconnect`
// clears a provider's tokens.
//
// Codex and Grok are device-code logins: the user opens a URL and enters the code, and CLIProxyAPI polls to
// completion in the background and writes the token to auth-dir, so the UI polls `accounts` until connected and
// never calls `complete`. Google's is a browser redirect to a loopback port that only exists inside this
// container, so nothing can observe the grant — the user pastes the URL they landed on and `complete` hands it
// back to CLIProxyAPI, which then finishes the exchange on its own and the UI polls `accounts` the same way.
export interface CliProxyClient {
    readonly accounts: () => Promise<Record<KeyedProvider, boolean>>;
    readonly connect: (provider: KeyedProvider) => Promise<{ url: string; code: string; state: string }>;
    readonly complete: (input: { provider: KeyedProvider; redirectUrl: string; state: string }) => Promise<void>;
    readonly disconnect: (provider: KeyedProvider) => Promise<void>;
}

export const createCliProxyClient = (params: { managementUrl: string; token: string; configPath: string }): CliProxyClient => {
    const { managementUrl, token, configPath } = params;
    const auth = { authorization: `Bearer ${token}` };

    const listFiles = async (): Promise<{ name?: string; provider?: string }[]> => {
        const response = await fetch(`${managementUrl}/auth-files`, { headers: auth });
        // Management not reachable (proxy still booting / not baked) ⇒ treat as nothing connected rather than throw.
        if (!response.ok) {
            return [];
        }
        return ((await response.json()) as { files?: { name?: string; provider?: string }[] }).files ?? [];
    };

    // Grok: CLIProxyAPI's xAI login is a device-code flow (headless-friendly) exposed over the Management API. It
    // returns the verification URL (with the code pre-filled) + user code and auto-polls to completion in the
    // background; the UI polls `accounts` until connected.
    const connectGrok = async (): Promise<{ url: string; code: string; state: string }> => {
        const response = await fetch(`${managementUrl}/xai-auth-url`, { headers: auth });
        if (!response.ok) {
            throw new Error(`xAI subscription login failed to start (${response.status})`);
        }
        const body = (await response.json()) as { url?: string; user_code?: string; state?: string };
        if (body.url === undefined) {
            throw new Error("xAI subscription login returned no verification URL");
        }
        return { url: body.url, code: body.user_code ?? "", state: body.state ?? "" };
    };

    // Gemini: CLIProxyAPI's Antigravity login is Google's ordinary browser OAuth — it hands back an authorize URL
    // and a `state`, then waits for the grant to land in its auth-dir. Google redirects to a loopback port bound
    // inside THIS container, which the user's browser can never reach, so the redirect always dead-ends in their
    // address bar; that URL carries the grant, and `complete` below posts it back. No device-code flow exists for
    // Google, so the empty `code` is what tells the card to ask for a paste instead of showing a code.
    const connectGemini = async (): Promise<{ url: string; code: string; state: string }> => {
        const response = await fetch(`${managementUrl}/antigravity-auth-url`, { headers: auth });
        if (!response.ok) {
            throw new Error(`Google sign-in failed to start (${response.status})`);
        }
        const body = (await response.json()) as { url?: string; state?: string };
        if (body.url === undefined || body.state === undefined || body.state === "") {
            throw new Error("Google sign-in returned no authorization URL");
        }
        return { url: body.url, code: "", state: body.state };
    };

    // Hand a pasted redirect URL back to CLIProxyAPI, which parses ?code=&state= out of it, matches it to the
    // pending session and resumes the token exchange in the background. Its rejections are the ones worth
    // reading (an expired handshake, a state that belongs to a different login), so surface its own message.
    const complete = async (input: { provider: KeyedProvider; redirectUrl: string; state: string }): Promise<void> => {
        const response = await fetch(`${managementUrl}/oauth-callback`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ provider: CLIPROXY_PROVIDER[input.provider], redirect_url: input.redirectUrl, state: input.state }),
        });
        if (!response.ok) {
            const reason = ((await response.json().catch(() => undefined)) as { error?: string } | undefined)?.error;
            throw new Error(reason ?? `Sign-in could not be completed (${response.status})`);
        }
    };

    // Codex: CLIProxyAPI's Management API Codex login is a browser-redirect flow (loopback callback) that can't
    // complete in a remote sandbox. Its device-code flow is only exposed as the `--codex-device-login` CLI command,
    // so drive that as a subprocess: parse the URL + code it prints, surface them, and leave it running to poll to
    // completion (writing the token to auth-dir). A superseding connect kills the prior child.
    let codexChild: ChildProcess | undefined;
    const connectCodex = (): Promise<{ url: string; code: string; state: string }> =>
        new Promise((resolve, reject) => {
            codexChild?.kill("SIGTERM");
            const child = spawn("cli-proxy-api", ["--codex-device-login", "--no-browser", "--config", configPath], {
                stdio: ["ignore", "pipe", "pipe"],
                env: process.env,
            });
            codexChild = child;
            let buffer = "";
            let url: string | undefined;
            let code: string | undefined;
            let settled = false;
            const onData = (chunk: Buffer): void => {
                buffer += chunk.toString();
                url = buffer.match(/Codex device URL:\s*(\S+)/)?.[1] ?? url;
                code = buffer.match(/Codex device code:\s*(\S+)/)?.[1] ?? code;
                if (!settled && url !== undefined && code !== undefined) {
                    settled = true;
                    // The subprocess owns the poll to completion, so there is no handshake for the UI to resume.
                    resolve({ url, code, state: "" });
                }
            };
            child.stdout?.on("data", onData);
            child.stderr?.on("data", onData);
            child.on("error", (error) => {
                if (!settled) {
                    settled = true;
                    reject(error);
                }
            });
            child.on("exit", (exitCode) => {
                if (child === codexChild) {
                    codexChild = undefined;
                }
                // Exit before we saw a code ⇒ the flow failed to start. Exit after ⇒ the poll finished (success or
                // timeout); the UI already learned the outcome by polling `accounts`.
                if (!settled) {
                    settled = true;
                    reject(new Error(`Codex device login exited (${exitCode}) before printing a code`));
                }
            });
        });

    const disconnect = async (provider: KeyedProvider): Promise<void> => {
        if (provider === "codex") {
            codexChild?.kill("SIGTERM");
            codexChild = undefined;
        }
        const cliproxyProvider = CLIPROXY_PROVIDER[provider];
        for (const file of await listFiles()) {
            if (file.provider === cliproxyProvider && file.name !== undefined) {
                await fetch(`${managementUrl}/auth-files?name=${encodeURIComponent(file.name)}`, { method: "DELETE", headers: auth });
            }
        }
    };

    return {
        accounts: async () => {
            const providers = new Set((await listFiles()).map((file) => file.provider));
            return {
                codex: providers.has(CLIPROXY_PROVIDER.codex),
                grok: providers.has(CLIPROXY_PROVIDER.grok),
                gemini: providers.has(CLIPROXY_PROVIDER.gemini),
            };
        },
        connect: (provider) => (provider === "grok" ? connectGrok() : provider === "gemini" ? connectGemini() : connectCodex()),
        complete,
        disconnect,
    };
};
