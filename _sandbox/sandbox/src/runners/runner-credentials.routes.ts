import { type AgentProvider, AgentProviderSchema, DEFAULT_PROVIDER } from "@intentic/sandbox-contract/schemas/agent";
import {
    type RunnerCredential,
    RunnerCredentialRefreshRequestSchema,
    RunnerCredentialRequestSchema,
    runnerTranslatorPath,
} from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { Context } from "hono";
import { replaceRejectedToken } from "../runtimes/claude/claude-credentials.js";
import type { Services } from "../composition.js";
import type { HarnessCredentialsResult } from "../agent/providers/harness-credentials.js";
import { REQUEST_REFRAMED, RESPONSE_REFRAMED, forwardHeaders } from "../http/forward-headers.js";
import { bearerPeer } from "../peers/peer-store.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { resolveHarnessCredentials } from "../agent/providers/harness-credentials.js";

// A runner's turns spend this sandbox's model providers through three bearer-authenticated routes:
// POST /system/runners/credentials: resolves one turn's credential, stripped to what may travel.
// POST /system/runners/credentials/refresh: re-mints a rejected access token against the local store.
// ALL /system/runners/translator/*: proxies the loopback translator so its local bearer never leaves.
// Never travels: refresh tokens, the translator's local bearer, or the per-model allowance (reads parent-local state).

// Exported for its unit test: every arm is a rule about what leaves the sandbox. `envOauth` travels as an ordinary
// oauth value since resolution answers {} for it; an API-key-shaped fallback stays home instead.
export const toRunnerCredential = (resolved: HarnessCredentialsResult, translatorUrl: string, envOauth: string): RunnerCredential => {
    if (!resolved.ok) {
        return { ok: false, ...(resolved.code !== undefined ? { code: resolved.code } : {}), message: resolved.message };
    }
    const { oauthToken, endpoint, account, trial } = resolved.credentials;
    if (endpoint !== undefined) {
        if (translatorUrl !== "" && endpoint.baseUrl === translatorUrl) {
            return { ok: true, kind: "parent-translator", model: endpoint.model, ...(trial === true ? { trial: true } : {}) };
        }
        return {
            ok: true,
            kind: "endpoint",
            baseUrl: endpoint.baseUrl,
            authToken: endpoint.authToken,
            model: endpoint.model,
            ...(trial === true ? { trial: true } : {}),
        };
    }
    if (oauthToken !== undefined) {
        return { ok: true, kind: "oauth", accessToken: oauthToken, ...(account !== undefined ? { account } : {}) };
    }
    if (envOauth !== "") {
        return { ok: true, kind: "oauth", accessToken: envOauth };
    }
    return {
        ok: false,
        message: "The origin sandbox has no credential this turn can travel with — connect a Claude account there.",
    };
};

// How this sandbox resolves one turn's credential, the way its own turns do; the app hands in the engine's.
export type CredentialResolver = (input: {
    readonly agent: AgentProvider | undefined;
    readonly account?: string;
    readonly model?: string;
}) => Promise<HarnessCredentialsResult>;

const createRunnerCredentialsRoute =
    (services: Pick<Services, "runners" | "logger" | "config">, resolve: CredentialResolver) =>
    async (c: Context): Promise<Response> => {
        const runner = await bearerPeer(services.runners, c);
        if (typeof runner !== "string") {
            return runner;
        }
        const body = RunnerCredentialRequestSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) {
            return c.json({ error: "invalid request" }, 400);
        }
        // An unrecognised provider id means the runner's build is newer; refuse readably instead of letting zod throw.
        const agent = body.data.agent === undefined ? undefined : AgentProviderSchema.safeParse(body.data.agent);
        if (agent !== undefined && !agent.success) {
            return c.json({ ok: false, message: `this sandbox does not know the provider "${body.data.agent}" — update it.` } satisfies RunnerCredential);
        }
        const resolved = await resolve({
            agent: agent?.data,
            ...(body.data.account !== undefined ? { account: body.data.account } : {}),
            ...(body.data.model !== undefined ? { model: body.data.model } : {}),
        });
        services.logger.info({ runner, agent: body.data.agent ?? DEFAULT_PROVIDER, ok: resolved.ok }, "runner: credential resolved for a remote turn");
        return c.json(toRunnerCredential(resolved, services.config.translator.url, services.config.claudeCodeOauthToken));
    };

const createRunnerCredentialRefreshRoute =
    (services: Pick<Services, "runners" | "logger" | "claudeStore">) =>
    async (c: Context): Promise<Response> => {
        const runner = await bearerPeer(services.runners, c);
        if (typeof runner !== "string") {
            return runner;
        }
        const body = RunnerCredentialRefreshRequestSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) {
            return c.json({ error: "invalid request" }, 400);
        }
        const accessToken = await replaceRejectedToken(services.claudeStore, body.data.account, body.data.rejected).catch((error: unknown) => {
            services.logger.warn({ err: error, runner, account: body.data.account }, "runner: mid-turn token re-mint failed");
            return undefined;
        });
        return c.json(accessToken !== undefined ? { accessToken } : {});
    };

// The runner's bearer must never reach the translator as the local one, so it goes with the hop-by-hop and reframed
// headers and the translator's own is set in its place.
const DROPPED_HEADERS = [...REQUEST_REFRAMED, "authorization"];

export const createRunnerTranslatorProxyRoute =
    (services: Pick<Services, "runners" | "config">) =>
    async (c: Context): Promise<Response> => {
        const runner = await bearerPeer(services.runners, c);
        if (typeof runner !== "string") {
            return runner;
        }
        const translator = services.config.translator;
        if (translator.url === "") {
            return c.json({ error: "this sandbox has no model translator" }, 503);
        }
        const rest = c.req.path.slice(runnerTranslatorPath.length);
        const url = new URL(c.req.url);
        const headers = forwardHeaders(c.req.raw.headers, DROPPED_HEADERS);
        headers.set("authorization", `Bearer ${translator.token}`);
        // Streamed both ways so a long SSE turn isn't buffered in memory; `duplex` lets fetch send an unmeasured body.
        const upstream = await fetch(`${translator.url.replace(/\/$/, "")}${rest}${url.search}`, {
            method: c.req.method,
            headers,
            ...(c.req.raw.body !== null ? { body: c.req.raw.body, duplex: "half" as const } : {}),
        } as RequestInit);
        // fetch has decoded the body and the translator's hop-by-hop headers describe its connection to this daemon, so
        // neither its encoding nor its framing goes on to the runner.
        return new Response(upstream.body, { status: upstream.status, headers: forwardHeaders(upstream.headers, RESPONSE_REFRAMED) });
    };

// The credential doors: per-turn access tokens, mid-turn re-mints, translator behind the runner's own bearer.
export const runnerCredentialRawRoutes = defineRawRoutes((services: Services) => ({
    "POST /system/runners/credentials": createRunnerCredentialsRoute(services, (input) => resolveHarnessCredentials(services, input)),
    "POST /system/runners/credentials/refresh": createRunnerCredentialRefreshRoute(services),
    "ALL /system/runners/translator/*": createRunnerTranslatorProxyRoute(services),
}));
