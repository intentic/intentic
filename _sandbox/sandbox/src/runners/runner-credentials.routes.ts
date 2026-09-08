import {
    AgentProviderSchema,
    type RunnerCredential,
    RunnerCredentialRefreshRequestSchema,
    RunnerCredentialRequestSchema,
    runnerTranslatorPath,
} from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { replaceRejectedToken } from "../runtimes/claude/claude-credentials.js";
import type { Services } from "../composition.js";
import { bearerFrom } from "../auth/auth.js";
import { type HarnessCredentialsResult, resolveHarnessCredentials } from "../agent/providers/harness-credentials.js";

// A runner's turns spend this sandbox's model providers through three bearer-authenticated routes:
// POST /system/runners/credentials: resolves one turn's credential, stripped to what may travel.
// POST /system/runners/credentials/refresh: re-mints a rejected access token against the local store.
// ALL /system/runners/translator/*: proxies the loopback translator so its local bearer never leaves.
// Never travels: refresh tokens, the translator's local bearer, or the per-model allowance (reads parent-local state).

const callerRunner = async (services: Services, c: Context): Promise<string | undefined> =>
    await services.runners.verify(bearerFrom(c.req.header("authorization")) ?? "");

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

export const createRunnerCredentialsRoute =
    (services: Services) =>
    async (c: Context): Promise<Response> => {
        const runner = await callerRunner(services, c);
        if (runner === undefined) {
            return c.json({ error: "unauthorized" }, 401);
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
        const resolved = await resolveHarnessCredentials(services, {
            agent: agent?.data,
            ...(body.data.account !== undefined ? { account: body.data.account } : {}),
            ...(body.data.model !== undefined ? { model: body.data.model } : {}),
        });
        services.logger.info({ runner, agent: body.data.agent ?? "claude", ok: resolved.ok }, "runner: credential resolved for a remote turn");
        return c.json(toRunnerCredential(resolved, services.config.translator.url, services.config.claudeCodeOauthToken));
    };

export const createRunnerCredentialRefreshRoute =
    (services: Services) =>
    async (c: Context): Promise<Response> => {
        const runner = await callerRunner(services, c);
        if (runner === undefined) {
            return c.json({ error: "unauthorized" }, 401);
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

// Hop-by-hop and identity headers: the runner's bearer must never reach the translator as the local one.
const DROPPED_HEADERS = new Set(["authorization", "host", "connection", "content-length", "transfer-encoding", "accept-encoding"]);

export const createRunnerTranslatorProxyRoute =
    (services: Services) =>
    async (c: Context): Promise<Response> => {
        if ((await callerRunner(services, c)) === undefined) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const translator = services.config.translator;
        if (translator.url === "") {
            return c.json({ error: "this sandbox has no model translator" }, 503);
        }
        const rest = c.req.path.slice(runnerTranslatorPath.length);
        const url = new URL(c.req.url);
        const headers = new Headers();
        for (const [name, value] of c.req.raw.headers) {
            if (!DROPPED_HEADERS.has(name.toLowerCase())) {
                headers.set(name, value);
            }
        }
        headers.set("authorization", `Bearer ${translator.token}`);
        // Streamed both ways so a long SSE turn isn't buffered in memory; `duplex` lets fetch send an unmeasured body.
        const upstream = await fetch(`${translator.url.replace(/\/$/, "")}${rest}${url.search}`, {
            method: c.req.method,
            headers,
            ...(c.req.raw.body !== null ? { body: c.req.raw.body, duplex: "half" as const } : {}),
        } as RequestInit);
        return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    };
