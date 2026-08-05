import {
    type AgentProvider,
    endpointIdOf,
    type KeyedProvider,
    NATIVE_PROVIDERS,
    type NativeProvider,
    PROVIDER_VENDOR,
} from "@intentic/sandbox-contract";
import { ensureFreshToken, replaceRejectedToken } from "../claude/claude-credentials.js";
import { unversionedBase } from "../endpoints/endpoint-config.js";
import { endpointModelId } from "../endpoints/endpoint-translator.js";
import type { Services } from "../composition.js";
import { accountWithHeadroom } from "../usage/account-usage.js";
import type { TurnLimit } from "../usage/translator-usage.js";

/* WHAT AUTHENTICATES A CLAUDE CODE HARNESS TURN, per provider — the one question every caller of that harness
 * has to answer before it can spawn anything, and there is now more than one caller: the chat's own turn route
 * and the quick-model one-shot behind the commit box's autofill. It lives here rather than inline in
 * agent.routes.ts because the alternative is two places deciding which providers ride the translator, and they
 * would drift silently — a helper that resolves credentials a different
 * way than the chat does is a helper that fails only for the users whose setup differs from the developer's.
 *
 * Two shapes come out, and they are mutually exclusive by construction:
 *   claude              → the account's Anthropic subscription OAuth (undefined ⇒ the container env fallback)
 *   codex/grok/kimi/gemini → the sandbox translator's endpoint + local bearer + an explicitly named model
 *
 * Note what setting `endpoint` implies downstream: agent.ts drops CLAUDE_CODE_OAUTH_TOKEN whenever a baseUrl is
 * present, so a subscription token can never leave for a foreign endpoint. That is why this returns the two as
 * one value rather than letting a caller assemble them.
 *
 * A refusal is a VALUE, not a throw. Every one of these is an ordinary state of a sandbox — no translator in
 * the image, a subscription the user hasn't connected — and each caller renders it its
 * own way: the turn route yields an error frame the composer's connect gate reads, the one-shot turns it into a
 * disabled button. `code` carries the machine-readable discriminator the UI keys off (AgentEvent's `error`). */

export interface HarnessEndpoint {
    readonly baseUrl: string;
    readonly authToken: string;
    // Required, not optional: a routed provider is reached through a translator that maps model → upstream, so
    // it has no account default to fall back on the way native Claude does.
    readonly model: string;
}

/* WHOSE ALLOWANCE THIS TURN SPENDS, and what is left of it — the two things the harness cannot tell us about
 * its own 429, and the reason they are attached to the CREDENTIAL rather than derived downstream.
 *
 * A routed turn runs the Claude Code harness against the translator but spends a Google (or ChatGPT, or Kimi)
 * subscription, and the harness knows only that a 429 came back. So it says "Claude", and it sets its retry
 * delay from its OWN backoff curve — 620ms, then 1072ms, then 2281ms. Reading that delay as a reset instant is
 * what put "Resets 5:32 PM" under a Google weekly quota that was five days out, on a turn that never touched
 * Anthropic.
 *
 * `limit` is bound to the turn's RESOLVED MODEL, not just its provider, because on Google those are different
 * allowances: one sign-in meters Gemini separately from the Claude and GPT models, and the pool a refusal names
 * has to be the pool the turn was spending. It also answers whether any connected account still has room —
 * CLIProxyAPI balances across the whole auth-file set, so a refusal with headroom left on file is a cooldown
 * rather than a spent plan, and those two want opposite things from the reader.
 *
 * Absent ⇒ a native Claude turn, whose harness reports both correctly by itself: it names its own vendor, and
 * on a subscription limit it sets the retry delay to the closed window's remaining lifetime. */
export interface TurnAllowance {
    readonly vendor: string;
    readonly limit: () => Promise<TurnLimit>;
}

export interface HarnessCredentials {
    readonly oauthToken?: string;
    // Re-mints `oauthToken` mid-turn. The CLI calls this when the API refuses the token it was given — expired
    // under a long turn, or revoked account-wide — and carries on with what comes back, so a credential that
    // dies while the agent is working costs a pause rather than the turn. Present only alongside a stored
    // account's token: the container-env fallback and the routed endpoints have nothing to rotate.
    readonly refreshOauthToken?: (context: { readonly signal: AbortSignal }) => Promise<string | undefined>;
    readonly endpoint?: HarnessEndpoint;
    // Which stored account answered — the attribution key stamped onto usage/rate-limit frames. Undefined when
    // the credential came from the container env or from the translator's own subscription rather than an
    // account this sandbox stores.
    readonly account?: string;
    // Set on a routed turn only: see TurnAllowance. A native Claude turn leaves it absent and the harness's own
    // reporting stands.
    readonly allowance?: TurnAllowance;
}

/* ONE ENDPOINT, ONE MODEL — the rule that makes everything a harness turn can spawn reachable.
 *
 * The harness resolves model names in more places than the turn's own `--model`: a subagent definition asks for
 * "sonnet", the Agent tool takes a per-call model override, background summarization and title generation reach
 * for the cheap tier. Each of those resolves through Claude Code's own alias table, which answers with an
 * Anthropic model id — and on a routed turn the endpoint those ids are sent to is the sandbox's translator,
 * which serves the user's ChatGPT/xAI/Google subscription and has never heard of `claude-opus-5`. It answers
 * 502 "unknown provider for model", which is how a Sol session's every Explore subagent died while the main
 * loop worked fine: the turn's own model came from `--model`, the subagent's came from the alias table.
 *
 * A custom endpoint serves exactly ONE model (harness-credentials resolves it against that provider's live
 * catalog), so every alias must resolve to that one. Setting the tier defaults is the harness's own supported
 * way to say that, and it covers the resolvers we do not call ourselves — including the ones inside the CLI.
 * CLAUDE_CODE_SUBAGENT_MODEL pins the Task tool's default on top, so a subagent spawned with no model named
 * lands on the routed model rather than on whatever the CLI's built-in default for that agent type is. */
const routedModelEnv = (model: string): Record<string, string> => ({
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    // The pre-tier name for the same slot, still read by parts of the CLI that predate the trio above.
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
});

/* The credential ENV a Claude Code harness process runs with, and the single place the withholding rule lives:
 * a custom endpoint gets its own bearer and the Anthropic subscription OAuth is DROPPED, so a subscription
 * token can never leave for a foreign endpoint. Read by the chat turn's options (agent.ts) and by the
 * quick-model one-shot, because a rule about where a credential may travel is the last one that should exist
 * twice. `IS_SANDBOX` rides along for the same reason both need it: Claude Code refuses to run under root
 * unless the environment is marked already-sandboxed, which this container is.
 *
 * `model` is the turn's resolved id. It only takes effect alongside a custom endpoint — a native Claude turn must
 * keep the real alias table, where "sonnet" and "opus" are different models and a subagent asking for the cheap
 * tier should get it. */
export const harnessEnv = (credentials: {
    readonly baseUrl?: string;
    readonly authToken?: string;
    readonly oauthToken?: string;
    readonly model?: string;
}): Record<string, string> => ({
    IS_SANDBOX: "1",
    /* RIDE OUT A PROVIDER BLIP INSIDE THE TURN, rather than dying and being resumed from outside it.
     *
     * The harness retries 5xx/529/dropped-socket failures by itself, but its default budget is tuned for a human
     * sitting at a terminal who can just press up-enter: ten attempts, and it gives up outright the moment the
     * provider asks for a wait longer than a minute — which is exactly what a provider in real trouble asks for.
     * This flag is the harness's own switch for the other case, an unattended agent that should keep trying:
     * three hundred attempts, no ceiling on the requested wait, and capacity refusals stop counting against the
     * budget at all.
     *
     * Worth far more than the resume it prevents. A retry inside the live turn keeps the session, the prompt
     * cache and whatever the agent had already done; a resume re-reads all of it and starts the turn again. So
     * this is the layer that should absorb almost every outage, with turn-resume.ts as the net under it for the
     * turns that die anyway — and the `provider_retry` frame (agent.ts) as the thing that makes the resulting
     * long silence legible instead of looking like a hang.
     *
     * Cost: the harness stops falling back to a cheaper model on server errors. We never set a fallback model,
     * so there is nothing to lose here. */
    CLAUDE_CODE_RETRY_WATCHDOG: "1",
    ...(credentials.baseUrl !== undefined
        ? {
              ANTHROPIC_BASE_URL: credentials.baseUrl,
              ...(credentials.authToken !== undefined ? { ANTHROPIC_AUTH_TOKEN: credentials.authToken } : {}),
              ...(credentials.model !== undefined ? routedModelEnv(credentials.model) : {}),
          }
        : credentials.oauthToken !== undefined
          ? { CLAUDE_CODE_OAUTH_TOKEN: credentials.oauthToken }
          : {}),
});

export type HarnessCredentialsResult =
    | { readonly ok: true; readonly credentials: HarnessCredentials }
    | { readonly ok: false; readonly code?: "subscription-required" | "claude-reauth"; readonly message: string };

// The label a routed provider's missing subscription is named by — the vendor's own noun, matching the connect
// prompts (PROVIDER_ACCESS.requirement).
const ROUTED_REQUIREMENT: Record<KeyedProvider, string> = {
    codex: "ChatGPT subscription",
    grok: "SuperGrok subscription",
    kimi: "Kimi Code subscription",
    gemini: "Google account",
};

// The upstream model id a routed turn hands the translator, which maps it to its provider. Unlike native Codex
// (which uses the ChatGPT account default and omits the model), the router requires an explicit id, and the only
// source that stays correct is the provider's own live catalog (discovery → persisted → seed floor, never
// empty): keep the pinned pick while the catalog still offers it, else take the catalog's default. Validating
// membership rather than naming a fallback id is what survives a retirement — a pick the provider has dropped
// simply fails the test and falls to the live default. That covers Codex's own `gpt-5-codex`, which the
// translator's ChatGPT subscription does not serve (it re-serves the account's real ids) and rejects with a
// non-SSE error body that breaks the harness stream; it needs no special case, and neither does Grok, whose
// routed turns previously pinned a hardcoded `grok-4` that consulted no catalog at all.
const routedModel = (catalog: { models: readonly { id: string }[]; default: string }, model: string | undefined): string =>
    model !== undefined && model !== "" && catalog.models.some((entry) => entry.id === model) ? model : catalog.default;

// Each routed provider resolves against its OWN live catalog — the same catalogs the native paths use, so a
// pick is validated identically whichever harness runs it.
const routedCatalog = async (services: Services, provider: KeyedProvider) => {
    if (provider === "codex") {
        return services.codexModels.models();
    }
    if (provider === "grok") {
        return services.openCode.xaiModels();
    }
    if (provider === "kimi") {
        return services.kimiModels.models();
    }
    return services.geminiModels.models();
};

/* WHICH PROVIDERS THIS HARNESS COULD ACTUALLY RUN RIGHT NOW — the cheap predicate mirroring the resolution
 * below, one entry per native provider in a single pass. It exists because a caller choosing BETWEEN providers
 * (the quick model) has to know all five before it picks one, and resolving credentials five times to find out
 * would refresh five tokens and fetch five catalogs to use one.
 *
 * The conditions are deliberately the same ones resolveHarnessCredentials refuses on, and they are all cheap
 * facts: a store listing, the translator's account map (fetched once here), a config string. Every route below
 * still resolves the real credential for the provider it settles on, so this being optimistic in some corner
 * costs an error message rather than a wrong turn. */
export const harnessReadyProviders = async (services: Services): Promise<Record<NativeProvider, boolean>> => {
    const translator = services.config.translator.url === "" ? undefined : await services.cliProxy.accounts();
    const routed = (provider: KeyedProvider): boolean => (translator?.[provider].length ?? 0) > 0;
    const ready: Record<NativeProvider, boolean> = {
        // A stored account, else the container's own credential — the same two rungs the claude branch takes.
        claude:
            (await services.claudeStore.list()).length > 0 || services.config.claudeCodeOauthToken !== "" || services.config.anthropicApiKey !== "",
        codex: routed("codex"),
        grok: routed("grok"),
        kimi: routed("kimi"),
        gemini: routed("gemini"),
    };
    // Named rather than returned raw so a provider added to NATIVE_PROVIDERS without a rung here fails the
    // type-check instead of silently reading back `undefined` (AgentProvider is a bare string on the wire).
    return Object.fromEntries(NATIVE_PROVIDERS.map((provider) => [provider, ready[provider]])) as Record<NativeProvider, boolean>;
};

/* AN `endpoint` CAPABILITY'S TURN — a model API the user configured, which is the same problem as a routed
 * subscription with one fork in it, and the fork is about the WIRE rather than about where the server runs.
 *
 * openai    — re-served through the translator, exactly as the four subscriptions are. The harness is handed the
 *             loopback bearer and a `<id>/<model>` id (endpointModelId, matching the entry's `prefix`), so the
 *             user's own key never enters the harness environment at all: it stays in the translator's config on
 *             /history, which is outside the agent's reach.
 * anthropic — the endpoint already speaks the harness's own wire, so the translator would be a hop that
 *             translates Anthropic to Anthropic. The harness goes straight at it with the user's key, and the
 *             base URL drops its version segment because the harness appends `/v1/messages` itself.
 *
 * The model is validated against the endpoint's live catalog exactly as a routed provider's is (routedModel): a
 * pick the server no longer offers falls to the catalog default rather than being sent and refused. An endpoint
 * that has published nothing has no default to fall back to, and that is a refusal rather than a turn sent with
 * an empty model — which the harness would answer by resolving its own Anthropic alias, at an endpoint that has
 * never heard of it. */
const resolveEndpointCredentials = async (
    services: Services,
    id: string,
    model: string | undefined,
): Promise<HarnessCredentialsResult> => {
    const capability = await services.capabilities.get(id);
    if (capability === undefined || capability.kind !== "endpoint") {
        return { ok: false, message: `Unknown model endpoint "${id}" — add it as an Endpoint capability first.` };
    }
    const config = capability.config;
    const catalog = await services.endpointModels.models(id, config);
    if (catalog.models.length === 0) {
        return {
            ok: false,
            message: `${id} has published no models — check the server is running at ${config.baseUrl} and has a model loaded.`,
        };
    }
    const resolved = routedModel(catalog, model);
    if (config.protocol === "anthropic") {
        return {
            ok: true,
            credentials: { endpoint: { baseUrl: unversionedBase(config.baseUrl), authToken: config.apiKey ?? "", model: resolved } },
        };
    }
    if (services.config.translator.url === "") {
        return {
            ok: false,
            message: "This sandbox has no model translator, so an OpenAI-compatible endpoint can't run here. Run a sandbox built from the published image.",
        };
    }
    return {
        ok: true,
        credentials: {
            endpoint: {
                baseUrl: services.config.translator.url,
                authToken: services.config.translator.token,
                model: endpointModelId(id, resolved),
            },
        },
    };
};

export const resolveHarnessCredentials = async (
    services: Services,
    input: { readonly agent: AgentProvider | undefined; readonly account?: string; readonly model?: string },
): Promise<HarnessCredentialsResult> => {
    const endpointId = input.agent === undefined ? undefined : endpointIdOf(input.agent);
    if (endpointId !== undefined) {
        return resolveEndpointCredentials(services, endpointId, input.model);
    }
    if (input.agent === "codex" || input.agent === "grok" || input.agent === "kimi" || input.agent === "gemini") {
        if (services.config.translator.url === "") {
            // Codex/Grok can fall back to their own runtime; Kimi/Gemini have none, so it can only be an image problem.
            const fallback =
                input.agent === "kimi" || input.agent === "gemini"
                    ? "Run a sandbox built from the published image."
                    : "Use the provider's native harness, or run a sandbox built from the published image.";
            return {
                ok: false,
                message: `This sandbox has no model translator, so a non-Claude model can't run under the Claude Code harness here. ${fallback}`,
            };
        }
        if ((await services.cliProxy.accounts())[input.agent].length === 0) {
            return {
                ok: false,
                code: "subscription-required",
                message: `Connect your ${ROUTED_REQUIREMENT[input.agent]} in Sandbox ▸ Agent to run ${input.agent} under the Claude Code harness.`,
            };
        }
        const catalog = await routedCatalog(services, input.agent);
        // Narrowed here rather than read off `input` inside the closure: the limit lookup outlives this call by
        // a whole turn, and `input.agent` is an open provider vocabulary everywhere else in the file.
        const routed = input.agent;
        // Named once and handed to both: the endpoint sends it upstream and the allowance reads the quota pool
        // it spends, and a refusal that named a different model's pool than the turn ran on is the bug this
        // pairing closes.
        const model = routedModel(catalog, input.model);
        return {
            ok: true,
            credentials: {
                endpoint: { baseUrl: services.config.translator.url, authToken: services.config.translator.token, model },
                allowance: { vendor: PROVIDER_VENDOR[routed], limit: () => services.cliProxy.turnLimit(routed, model) },
            },
        };
    }
    // An unnamed account is chosen by HEADROOM, not by connection order — see accountWithHeadroom. The order
    // handed over is the store's own (connectedAt), which stays the tiebreak between equals, so a sandbox whose
    // accounts all read the same still behaves exactly as it did.
    const accountId =
        input.account ??
        (await accountWithHeadroom(
            services.accountUsage,
            (await services.claudeStore.list()).map((account) => account.id),
        ));
    // A refresh that fails joins the other refusals rather than throwing past the caller: a stored account whose
    // token can no longer be renewed is the same class of problem as one that was never connected, and both end
    // at the same place on the surface. Reported with the store's own message, which says which of the several
    // ways a refresh can fail actually happened.
    let oauthToken: string | undefined;
    if (accountId !== undefined) {
        try {
            oauthToken = await ensureFreshToken(services.claudeStore, accountId);
        } catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : "claude credentials unavailable" };
        }
    }
    if (oauthToken === undefined && services.config.claudeCodeOauthToken === "" && services.config.anthropicApiKey === "") {
        // A connected-but-revoked account is a different problem from having no account at all, and it has a
        // different fix: reconnect this one, in place, rather than go find Setup. The code lets the UI offer
        // that inline and hold the message for replay once it lands.
        const revoked = accountId !== undefined && (await services.claudeStore.list()).some((a) => a.id === accountId && a.needsReauth === true);
        return revoked
            ? { ok: false, code: "claude-reauth", message: "Claude sign-in was revoked — reconnect the account to pick this conversation back up." }
            : { ok: false, message: "No Claude account connected — connect it in Setup before chatting." };
    }
    // Attribution follows the TOKEN, not the id: an account whose refresh yielded nothing served none of this
    // turn (the container's own credential did), so naming it would file the usage against one that never ran.
    if (oauthToken === undefined) {
        return { ok: true, credentials: {} };
    }
    // Hand the CLI a way to re-mint the token it was given. It calls this on a 401 and carries on with the
    // result, so a credential that expires or is revoked mid-turn costs a pause instead of the turn's work.
    // `current` tracks what the CLI holds so the rotation supersedes exactly that one — and so a token another
    // turn already rotated is adopted, never re-refreshed.
    let current: string | undefined = oauthToken;
    const refreshOauthToken = async (): Promise<string | undefined> => {
        if (current === undefined || accountId === undefined) {
            return undefined;
        }
        const replacement = await replaceRejectedToken(services.claudeStore, accountId, current).catch((error: unknown) => {
            services.logger.warn({ err: error, account: accountId }, "claude mid-turn token refresh failed");
            return undefined;
        });
        current = replacement;
        return replacement;
    };
    return { ok: true, credentials: { oauthToken, refreshOauthToken, ...(accountId !== undefined ? { account: accountId } : {}) } };
};
