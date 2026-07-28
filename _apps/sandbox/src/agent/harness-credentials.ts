import { type AgentProvider, NATIVE_PROVIDERS, type NativeProvider } from "@intentic/sandbox-contract";
import { ensureFreshToken, replaceRejectedToken } from "../claude/claude-credentials.js";
import { resolveKimiKey } from "../kimi/kimi-credentials.js";
import { MOONSHOT_ANTHROPIC_BASE } from "../kimi/kimi-models.js";
import type { Services } from "../composition.js";

/* WHAT AUTHENTICATES A CLAUDE CODE HARNESS TURN, per provider — the one question every caller of that harness
 * has to answer before it can spawn anything, and there is now more than one caller: the chat's own turn route
 * and the quick-model one-shot behind the commit box's autofill. It lives here rather than inline in
 * agent.routes.ts because the alternative is two places deciding whether Gemini rides the translator and which
 * Moonshot key a Kimi call uses, and they would drift silently — a helper that resolves credentials a different
 * way than the chat does is a helper that fails only for the users whose setup differs from the developer's.
 *
 * Three shapes come out, and they are mutually exclusive by construction:
 *   claude              → the account's Anthropic subscription OAuth (undefined ⇒ the container env fallback)
 *   codex/grok/gemini   → the sandbox translator's endpoint + local bearer + an explicitly named model
 *   kimi                → Moonshot's Anthropic-compatible endpoint + the sandbox-owned API key
 *
 * Note what setting `endpoint` implies downstream: agent.ts drops CLAUDE_CODE_OAUTH_TOKEN whenever a baseUrl is
 * present, so a subscription token can never leave for a foreign endpoint. That is why this returns the two as
 * one value rather than letting a caller assemble them.
 *
 * A refusal is a VALUE, not a throw. Every one of these is an ordinary state of a sandbox — no translator in
 * the image, a subscription the user hasn't connected, a Kimi key never added — and each caller renders it its
 * own way: the turn route yields an error frame the composer's connect gate reads, the one-shot turns it into a
 * disabled button. `code` carries the machine-readable discriminator the UI keys off (AgentEvent's `error`). */

export interface HarnessEndpoint {
    readonly baseUrl: string;
    readonly authToken: string;
    // Required, not optional: a routed provider is reached through a translator that maps model → upstream, so
    // it has no account default to fall back on the way native Claude does.
    readonly model: string;
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
}

/* The credential ENV a Claude Code harness process runs with, and the single place the withholding rule lives:
 * a custom endpoint gets its own bearer and the Anthropic subscription OAuth is DROPPED, so a subscription
 * token can never leave for a foreign endpoint. Read by the chat turn's options (agent.ts) and by the
 * quick-model one-shot, because a rule about where a credential may travel is the last one that should exist
 * twice. `IS_SANDBOX` rides along for the same reason both need it: Claude Code refuses to run under root
 * unless the environment is marked already-sandboxed, which this container is. */
export const harnessEnv = (credentials: {
    readonly baseUrl?: string;
    readonly authToken?: string;
    readonly oauthToken?: string;
}): Record<string, string> => ({
    IS_SANDBOX: "1",
    ...(credentials.baseUrl !== undefined
        ? { ANTHROPIC_BASE_URL: credentials.baseUrl, ...(credentials.authToken !== undefined ? { ANTHROPIC_AUTH_TOKEN: credentials.authToken } : {}) }
        : credentials.oauthToken !== undefined
          ? { CLAUDE_CODE_OAUTH_TOKEN: credentials.oauthToken }
          : {}),
});

export type HarnessCredentialsResult =
    | { readonly ok: true; readonly credentials: HarnessCredentials }
    | { readonly ok: false; readonly code?: "subscription-required" | "claude-reauth"; readonly message: string };

// The label a routed provider's missing subscription is named by — the vendor's own noun, matching the connect
// prompts (PROVIDER_ACCESS.requirement).
const ROUTED_REQUIREMENT: Record<"codex" | "grok" | "gemini", string> = {
    codex: "ChatGPT subscription",
    grok: "SuperGrok subscription",
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
const routedCatalog = async (services: Services, provider: "codex" | "grok" | "gemini") => {
    if (provider === "codex") {
        return services.codexModels.models();
    }
    if (provider === "grok") {
        return services.openCode.xaiModels();
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
    const routed = (provider: "codex" | "grok" | "gemini"): boolean => translator?.[provider] === true;
    const ready: Record<NativeProvider, boolean> = {
        // A stored account, else the container's own credential — the same two rungs the claude branch takes.
        claude:
            (await services.claudeStore.list()).length > 0 || services.config.claudeCodeOauthToken !== "" || services.config.anthropicApiKey !== "",
        codex: routed("codex"),
        grok: routed("grok"),
        gemini: routed("gemini"),
        kimi: (await services.kimiStore.list()).length > 0 || services.config.moonshotApiKey !== "",
    };
    // Named rather than returned raw so a provider added to NATIVE_PROVIDERS without a rung here fails the
    // type-check instead of silently reading back `undefined` (AgentProvider is a bare string on the wire).
    return Object.fromEntries(NATIVE_PROVIDERS.map((provider) => [provider, ready[provider]])) as Record<NativeProvider, boolean>;
};

export const resolveHarnessCredentials = async (
    services: Services,
    input: { readonly agent: AgentProvider | undefined; readonly account?: string; readonly model?: string },
): Promise<HarnessCredentialsResult> => {
    if (input.agent === "codex" || input.agent === "grok" || input.agent === "gemini") {
        if (services.config.translator.url === "") {
            // Codex/Grok can fall back to their own runtime; Gemini has none, so it can only be an image problem.
            const fallback =
                input.agent === "gemini"
                    ? "Run a sandbox built from the published image."
                    : "Use the provider's native harness, or run a sandbox built from the published image.";
            return {
                ok: false,
                message: `This sandbox has no model translator, so a non-Claude model can't run under the Claude Code harness here. ${fallback}`,
            };
        }
        if (!(await services.cliProxy.accounts())[input.agent]) {
            return {
                ok: false,
                code: "subscription-required",
                message: `Connect your ${ROUTED_REQUIREMENT[input.agent]} in Sandbox ▸ Agent to run ${input.agent} under the Claude Code harness.`,
            };
        }
        const catalog = await routedCatalog(services, input.agent);
        return {
            ok: true,
            credentials: {
                endpoint: {
                    baseUrl: services.config.translator.url,
                    authToken: services.config.translator.token,
                    model: routedModel(catalog, input.model),
                },
            },
        };
    }
    if (input.agent === "kimi") {
        // Kimi (Moonshot) speaks the Anthropic Messages protocol, so it runs on THIS harness with the endpoint
        // pointed at Moonshot's Anthropic-compatible base and authenticated with the sandbox-owned API key (the
        // selected account's, else the first stored one, else the container MOONSHOT_API_KEY).
        const resolved = await resolveKimiKey(services.kimiStore, services.config, input.account);
        if (resolved === undefined) {
            return {
                ok: false,
                code: "subscription-required",
                message: "No Kimi account connected — add your Kimi (Moonshot) API key in Sandbox ▸ Agent before chatting.",
            };
        }
        // Resolve a concrete model so the turn never sends an empty id to Moonshot: the pinned pick, else the
        // live catalog default (discovery → persisted → seed floor, never empty).
        const model = input.model !== undefined && input.model !== "" ? input.model : (await services.kimiModels.models()).default;
        return {
            ok: true,
            credentials: {
                // Absent when the key came from the container MOONSHOT_API_KEY rather than a stored account.
                ...(resolved.accountId !== undefined ? { account: resolved.accountId } : {}),
                endpoint: { baseUrl: MOONSHOT_ANTHROPIC_BASE, authToken: resolved.apiKey, model },
            },
        };
    }
    const accountId = input.account ?? (await services.claudeStore.list())[0]?.id;
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
