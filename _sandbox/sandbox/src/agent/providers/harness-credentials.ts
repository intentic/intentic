import {
    type AgentProvider,
    endpointIdOf,
    type MintedProvider,
    mintedVariant,
    type ModelRef,
    type NativeProvider,
    preferredAccount,
    PROVIDER_ACCESS,
    PROVIDER_VENDOR,
    providerLabel,
    TRIAL_ENDPOINT_ID,
    TRIAL_MODEL_ID,
} from "@intentic/sandbox-contract";
import { ensureFreshToken, replaceRejectedToken } from "../../runtimes/claude/claude-credentials.js";
import { unversionedBase } from "../../endpoints/endpoint-config.js";
import { endpointModelId } from "../../endpoints/endpoint-translator.js";
import { endpointConfigOf } from "../../endpoints/local-model.js";
import type { Services } from "../../composition.js";
import { serviceabilities } from "../../usage/serviceability/serviceability.js";
import type { TurnLimit } from "../../usage/serviceability/fleet-limit.js";
import type { HarnessCredential } from "./agent-request.js";

// What authenticates a Claude Code harness turn, per provider. Two mutually exclusive shapes: `claude` carries the
// account's Anthropic OAuth; other providers carry a translator endpoint, bearer and explicit model. A refusal is a
// returned value, not a throw; `code` is the machine-readable discriminator.

export interface HarnessEndpoint {
    readonly baseUrl: string;
    readonly authToken: string;
    // Required: a routed provider has no account default to fall back to, unlike native Claude.
    readonly model: string;
}

// Whose allowance a turn spends and what's left of it; the harness misreports this for a routed turn. `limit` is bound
// to the resolved model since some vendors meter models separately. Absent means a native Claude turn.
export interface TurnAllowance {
    readonly vendor: string;
    // Optional: a minted provider publishes no quota surface, so it names its vendor and omits this.
    readonly limit?: () => Promise<TurnLimit>;
}

export interface HarnessCredentials {
    readonly oauthToken?: string;
    // Re-mints `oauthToken` mid-turn on refusal; present only alongside a stored account's token.
    readonly refreshOauthToken?: (context: { readonly signal: AbortSignal }) => Promise<string | undefined>;
    readonly endpoint?: HarnessEndpoint;
    // Which stored account answered; undefined for the container-env or translator-subscription credential.
    readonly account?: string;
    // Set only on a routed turn; a native Claude turn leaves it absent and reports for itself.
    readonly allowance?: TurnAllowance;
    // Marks the platform free trial: gets a bounded retry/error policy, not the long-lived provider watchdog.
    readonly trial?: boolean;
}

// A custom endpoint serves exactly one model, so every alias the harness resolves (opus/sonnet/haiku, subagent, Task
// tool default) must map to it, including resolvers the caller never invokes directly.
const routedModelEnv = (model: string): Record<string, string> => ({
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    // Pre-tier name for the same slot, still read by parts of the CLI that predate the trio above.
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
});

// What each credential puts in the harness's env. A custom endpoint gets its own bearer and never the subscription OAuth,
// so it can't leave for a foreign endpoint; `model` only takes effect alongside a custom endpoint.
const credentialEnv = (credential: HarnessCredential, model: string | undefined): Record<string, string> => {
    switch (credential.kind) {
        case "routed":
        case "trial":
            return {
                ANTHROPIC_BASE_URL: credential.baseUrl,
                ANTHROPIC_AUTH_TOKEN: credential.authToken,
                ...(model !== undefined ? routedModelEnv(model) : {}),
            };
        case "claude-oauth":
            return { CLAUDE_CODE_OAUTH_TOKEN: credential.token };
        case "container":
            return {};
    }
};

// Env for a Claude Code harness process. `helper` is a one-shot rather than a turn: a turn tolerates waiting
// (resumable), a helper should fail fast.
export const harnessEnv = (
    credential: HarnessCredential,
    options: { readonly model?: string | undefined; readonly helper?: boolean } = {},
): Record<string, string> => ({
    IS_SANDBOX: "1",
    // Turn-only: rides out provider blips via retries instead of dying and resuming; helpers and the trial fail fast.
    ...(options.helper === true || credential.kind === "trial" ? {} : { CLAUDE_CODE_RETRY_WATCHDOG: "1" }),
    ...credentialEnv(credential, options.model),
});

// The resolver's answer as the credential a harness request carries: a routed endpoint (the trial is its own kind), a
// stored account's token with its refresher, or nothing, which leaves the container's own env to authenticate.
export const harnessCredentialOf = (credentials: HarnessCredentials): HarnessCredential => {
    const { endpoint, oauthToken, refreshOauthToken, allowance, trial } = credentials;
    if (endpoint !== undefined) {
        return trial === true
            ? { kind: "trial", baseUrl: endpoint.baseUrl, authToken: endpoint.authToken }
            : { kind: "routed", baseUrl: endpoint.baseUrl, authToken: endpoint.authToken, ...(allowance !== undefined ? { allowance } : {}) };
    }
    if (oauthToken === undefined) {
        return { kind: "container" };
    }
    return { kind: "claude-oauth", token: oauthToken, ...(refreshOauthToken !== undefined ? { refresh: refreshOauthToken } : {}) };
};

export type HarnessCredentialsResult =
    | { readonly ok: true; readonly credentials: HarnessCredentials }
    | {
          readonly ok: false;
          readonly code?: "subscription-required" | "claude-reauth" | "trial-unavailable";
          readonly message: string;
          // The account the refusal is about, where it names one: what a reconnect badge belongs on.
          readonly account?: string;
      };

const requirementOf = (provider: NativeProvider): string => PROVIDER_ACCESS[provider].requirement;

// Validates a routed model pick against the live catalog; falls to the catalog default if the pick isn't offered.
// Exported so context-budget.ts budgets against the same model this will actually send.
export const routedModel = (catalog: { models: readonly { id: string }[]; default: string }, model: string | undefined): string =>
    model !== undefined && model !== "" && catalog.models.some((entry) => entry.id === model) ? model : catalog.default;

// What resolving a harness credential reads of the daemon: the stores behind every provider's credential, the runner's
// parent, and the endpoint catalogs a routed pick is validated against.
export type HarnessCredentialDeps = Pick<
    Services,
    | "accountUsage"
    | "capabilities"
    | "claudeSeats"
    | "claudeStore"
    | "cliProxy"
    | "config"
    | "endpointModels"
    | "headroom"
    | "logger"
    | "minted"
    | "providerCatalogs"
    | "providerRefusals"
    | "runnerParent"
    | "trial"
    | "wakeLocalModel"
>;

// The model an unnamed Claude pick is judged for: the one the turn names, else the catalog's default, which is what the
// CLI runs. Asked with no model, the rule answers whether SOME turn can run, and an account whose only full pool is the
// default model's own slice would win a pick it then loses.
const pickModel = async (services: Pick<Services, "providerCatalogs">, model: string | undefined): Promise<ModelRef | undefined> => {
    if (model !== undefined && model !== "") {
        return { id: model };
    }
    // allow(silent-catch): an unreadable catalog only leaves the pick asking whether SOME turn can run, never fails the turn.
    const fallback = await services.providerCatalogs.claude.models().then(
        (catalog) => catalog.default,
        () => undefined,
    );
    return fallback === undefined ? undefined : { id: fallback };
};

// openai-protocol endpoints run through the translator, keeping the user's key out of the harness; anthropic-protocol
// endpoints get the harness pointed at them directly, key and all.
// Resolves from constants, not discovery: the trial's model id and route are fixed. Gates on the platform's cached
// trial-offered capability, re-probing once if the cache is cold.
const resolveTrialCredentials = async (services: Pick<Services, "capabilities" | "config" | "trial">): Promise<HarnessCredentialsResult> => {
    if ((await services.capabilities.get(TRIAL_ENDPOINT_ID)) === undefined) {
        await services.trial.refresh();
    }
    const capability = await services.capabilities.get(TRIAL_ENDPOINT_ID);
    if (capability === undefined || capability.kind !== "endpoint") {
        return {
            ok: false,
            code: "trial-unavailable",
            message: "The free trial is no longer available from this sandbox. Connect Google in Sandbox ▸ Agent to keep going for free.",
        };
    }
    if (services.config.translator.url === "") {
        return {
            ok: false,
            code: "trial-unavailable",
            message:
                "The free trial needs the sandbox's bundled model translator. Rebuild this sandbox from the published image, or connect Google in Sandbox ▸ Agent.",
        };
    }
    return {
        ok: true,
        credentials: {
            endpoint: {
                baseUrl: services.config.translator.url,
                authToken: services.config.translator.token,
                model: endpointModelId(TRIAL_ENDPOINT_ID, TRIAL_MODEL_ID),
            },
            trial: true,
        },
    };
};

// Idle-unload may have stopped this server, and the model catalog asks the server itself — so it has to be up before
// that question is worth asking. A wake that fails changes nothing: the empty catalog then reports it as not serving,
// which is what a model that cannot start looks like either way.
//
// Through Services rather than by calling the handler: importing it here put agent/providers into the capability
// graph and cost the whole package's type inference (a `TurnAllowance` that resolved to its error branch alone, two
// files away). The daemon wires the closure in composition, where everything is already imported.
const wakeIfLocalModel = async (services: Pick<Services, "wakeLocalModel">, kind: string, id: string): Promise<void> => {
    if (kind !== "localmodel") {
        return;
    }
    await services.wakeLocalModel(id);
};

const resolveEndpointCredentials = async (
    services: Pick<Services, "capabilities" | "config" | "endpointModels" | "trial" | "wakeLocalModel">,
    id: string,
    model: string | undefined,
): Promise<HarnessCredentialsResult> => {
    if (id === TRIAL_ENDPOINT_ID) {
        return resolveTrialCredentials(services);
    }
    const capability = await services.capabilities.get(id);
    // A localmodel capability resolves here too, as its loopback endpoint; id is `endpoint/<id>` either way.
    const config = capability === undefined ? undefined : endpointConfigOf(capability);
    if (capability === undefined || config === undefined) {
        return { ok: false, message: `Unknown model endpoint "${id}", add it as an Endpoint capability first.` };
    }
    await wakeIfLocalModel(services, capability.kind, id);
    const catalog = await services.endpointModels.models(id, config);
    if (catalog.models.length === 0) {
        return {
            ok: false,
            // Nothing published usually means weights are still downloading or loading, not misconfigured.
            message:
                capability.kind === "localmodel"
                    ? `${id} isn't serving yet, its model may still be downloading or loading. Check its capability card.`
                    : `${id} has published no models, check the server is running at ${config.baseUrl} and has a model loaded.`,
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
            message:
                "This sandbox has no model translator, so an OpenAI-compatible endpoint can't run here. Run a sandbox built from the published image.",
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

// The refusal for a conversation whose own account is no longer connected: which way on is the person's to choose.
const goneAccountMessage = (provider: string): string =>
    `The ${provider} account this conversation runs on is no longer connected. Pick another account for it, or connect this one again, then send again.`;

// A minted provider publishes an Anthropic Messages endpoint directly, so the harness is pointed at it with the
// sign-in's key; no translation needed.
const resolveMintedCredentials = async (
    services: Pick<Services, "minted">,
    provider: MintedProvider,
    input: { readonly account?: string; readonly model?: string },
): Promise<HarnessCredentialsResult> => {
    const accounts = await services.minted[provider].store.credentials();
    // The account the conversation runs on; only a turn naming none takes the first. A named one that is gone refuses:
    // running on another account instead is a switch nobody chose.
    const picked = input.account === undefined ? accounts[0] : accounts.find((account) => account.id === input.account);
    if (picked === undefined && input.account !== undefined) {
        return { ok: false, message: goneAccountMessage(providerLabel(provider)) };
    }
    if (picked === undefined) {
        return {
            ok: false,
            code: "subscription-required",
            message: `Connect your ${requirementOf(provider)} in Sandbox ▸ Agent to run ${providerLabel(provider)}.`,
        };
    }
    // An estate the provider no longer has is refused, not defaulted to a host the key was never minted for.
    const variant = mintedVariant(provider, picked.variant);
    if (variant === undefined) {
        return {
            ok: false,
            code: "subscription-required",
            message: `That ${providerLabel(provider)} account was connected through a sign-in this sandbox no longer offers. Connect it again in Sandbox ▸ Agent.`,
        };
    }
    // Validated against the estate's live catalog; a retired pick falls to the catalog default, never empty.
    const catalog = await services.minted[provider].catalogOf(variant.id).models();
    return {
        ok: true,
        credentials: {
            endpoint: { baseUrl: unversionedBase(variant.anthropicBase), authToken: picked.apiKey, model: routedModel(catalog, input.model) },
            account: picked.id,
            // No `limit`: neither vendor here publishes a quota surface a minted key can read.
            allowance: { vendor: PROVIDER_VENDOR[provider] },
        },
    };
};

// How long an unnamed pick waits for headroom to refresh before ranking accounts.
const PICK_REFRESH_WAIT_MS = 1_000;

export const resolveHarnessCredentials = async (
    services: HarnessCredentialDeps,
    input: { readonly agent: AgentProvider | undefined; readonly account?: string; readonly model?: string },
): Promise<HarnessCredentialsResult> => {
    // A runner resolves via its parent first, falling back to its own accounts if the parent is unreachable.
    const parent = services.runnerParent.current;
    if (parent !== undefined) {
        try {
            return await parent.resolve({
                ...(input.agent !== undefined ? { agent: input.agent } : {}),
                ...(input.account !== undefined ? { account: input.account } : {}),
                ...(input.model !== undefined ? { model: input.model } : {}),
            });
        } catch (error) {
            services.logger.warn({ err: error }, "runner: the parent's credential door is unreachable — falling back to this runner's own accounts");
        }
    }
    const endpointId = input.agent === undefined ? undefined : endpointIdOf(input.agent);
    if (endpointId !== undefined) {
        return resolveEndpointCredentials(services, endpointId, input.model);
    }
    // Gemini has no credential here: it refuses the Claude Code loop and always runs on its own runtime.
    if (input.agent === "gemini") {
        return {
            ok: false,
            message: "Gemini doesn't run under the Claude Code harness, Google refuses that loop. It runs on its own runtime instead.",
        };
    }
    if (input.agent === "cursor") {
        return {
            ok: false,
            message: "Cursor doesn't run under the Claude Code harness. It runs on its own runtime instead.",
        };
    }
    if (input.agent !== undefined && mintedVariant(input.agent) !== undefined) {
        return await resolveMintedCredentials(services, input.agent as MintedProvider, input);
    }
    if (input.agent === "codex" || input.agent === "grok" || input.agent === "kimi") {
        if (services.config.translator.url === "") {
            // Codex/Grok fall back to native; Kimi has none, so this is only an image problem for it.
            const fallback =
                input.agent === "kimi"
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
                message: `Connect your ${requirementOf(input.agent)} in Sandbox ▸ Agent to run ${input.agent} under the Claude Code harness.`,
            };
        }
        // Validated against the provider's own live catalog, same table the native paths and picker read.
        const catalog = await services.providerCatalogs[input.agent].models();
        // Narrowed here since the limit lookup outlives this call, unlike the broader `input.agent` type.
        const routed = input.agent;
        // Named once and shared: the endpoint sends it upstream and the allowance reads the pool it spends.
        const model = routedModel(catalog, input.model);
        return {
            ok: true,
            credentials: {
                endpoint: { baseUrl: services.config.translator.url, authToken: services.config.translator.token, model },
                allowance: { vendor: PROVIDER_VENDOR[routed], limit: () => services.cliProxy.turnLimit(routed, model) },
            },
        };
    }
    // An unnamed account is picked by the one serviceability rule (usage/serviceability.ts); a named account is never
    // filtered. The only account there is runs whatever its state: a failure now explains itself, unlike a stale verdict.
    // Refreshed within a bounded wait: a slow endpoint costs the pick freshness, not the turn its start.
    const unnamed = input.account === undefined;
    const connected = unnamed ? await services.claudeStore.list() : [];
    if (unnamed && connected.length > 1) {
        await services.headroom.refresh({ scope: { providers: ["claude"] }, withinMs: PICK_REFRESH_WAIT_MS });
    }
    const accountId =
        input.account ?? (connected.length > 1 ? preferredAccount(await serviceabilities(services, "claude", await pickModel(services, input.model)))?.id : connected[0]?.id);
    // A refresh failure joins the other refusals rather than throwing past the caller.
    let oauthToken: string | undefined;
    if (accountId !== undefined) {
        try {
            oauthToken = await ensureFreshToken(services.claudeStore, accountId);
        } catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : "claude credentials unavailable" };
        }
    }
    // A named account that yields no token refuses whatever else could authenticate: the container's own credential is
    // a different identity, and running on it is an account switch nobody chose. An unnamed turn may still fall to it.
    const named = input.account !== undefined;
    if (oauthToken === undefined && (named || (services.config.claudeCodeOauthToken === "" && services.config.anthropicApiKey === ""))) {
        // A connected-but-revoked account gets a reconnect refusal, not a generic no-account message.
        const revoked = accountId !== undefined && (await services.claudeStore.list()).some((a) => a.id === accountId && a.needsReauth === true);
        if (revoked) {
            return {
                ok: false,
                code: "claude-reauth",
                message: "Claude sign-in was revoked, reconnect the account to pick this conversation back up.",
                account: accountId,
            };
        }
        return { ok: false, message: named ? goneAccountMessage("Claude") : "No Claude account connected, connect it in Setup before chatting." };
    }
    // Attribution follows the token: an account whose refresh yielded nothing served none of this turn.
    if (oauthToken === undefined) {
        return { ok: true, credentials: {} };
    }
    // Lets the CLI re-mint the token on a 401; `current` tracks it so another turn's rotation is adopted.
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
