import {
    AgentProviderSchema,
    type RunnerCredential,
    RunnerCredentialRefreshRequestSchema,
    RunnerCredentialRequestSchema,
    runnerTranslatorPath,
} from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { replaceRejectedToken } from "../claude/claude-credentials.js";
import type { Services } from "../composition.js";
import { bearerFrom } from "../auth/auth.js";
import { type HarnessCredentialsResult, resolveHarnessCredentials } from "../agent/harness-credentials.js";

/* THE PARENT'S CREDENTIAL DOORS (runner-protocol.ts says the trust shape): a runner's turns spend THIS
 * sandbox's model providers. Three routes, all bearer-authenticated by the runner's own token:
 *
 *   POST /system/runners/credentials          resolve one turn's credential, with the same code and the same
 *                                             refusals a local turn gets (resolveHarnessCredentials), then
 *                                             strip it to what may travel (toRunnerCredential).
 *   POST /system/runners/credentials/refresh  re-mint a rejected access token mid-turn; the rotation runs
 *                                             HERE, against the store that holds the refresh token.
 *   ALL  /system/runners/translator/*         the loopback translator, re-served: the proxy swaps the
 *                                             runner's bearer for the translator's local one and streams
 *                                             both ways, so a subscription auth file never leaves /history.
 *
 * What deliberately never travels: refresh tokens (the rotation race two daemons refreshing one account
 * would run), the translator's local bearer (the runner presents its OWN token, which this daemon can
 * revoke), and the per-model allowance closure (it reads parent-local usage state; the harness's own
 * rate-limit reporting stands on remote turns). */

const callerRunner = async (services: Services, c: Context): Promise<string | undefined> =>
    await services.runners.verify(bearerFrom(c.req.header("authorization")) ?? "");

/* A resolved credential, stripped to what may travel. Exported for its unit test: every arm here is a rule
 * about what leaves the sandbox, which is exactly the class of logic that must not be tested through a live
 * translator. `envOauth` is the parent's container-env fallback token: resolution answers `{}` for it (the
 * SDK reads the env), but a runner has no such env, so it travels as an ordinary oauth value — it IS one,
 * just one with nothing to rotate. An env fallback that is only an API key stays home: the harness reads
 * that shape from the process env alone, and a refusal naming the fix beats a turn that half-works. */
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
        // The provider arrives as the open string the turn named; an id this build does not know is the
        // runner's build being newer, worth a readable refusal rather than a zod throw.
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

// Hop-by-hop and identity headers the proxy must not forward: the target sees the proxy's own connection,
// and the runner's bearer must never reach the translator as if it were the local one.
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
        /* Streamed through, both directions: a model turn is one long SSE response and possibly a long
         * request body, and buffering either would hold a whole turn in memory. `duplex` is what node fetch
         * requires to send a body it cannot measure. */
        const upstream = await fetch(`${translator.url.replace(/\/$/, "")}${rest}${url.search}`, {
            method: c.req.method,
            headers,
            ...(c.req.raw.body !== null ? { body: c.req.raw.body, duplex: "half" as const } : {}),
        } as RequestInit);
        return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    };
