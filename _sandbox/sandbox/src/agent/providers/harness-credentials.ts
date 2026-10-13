import {
    type AgentProvider,
    endpointIdOf,
    loopsOf,
    type ModelRef,
    preferredAccount,
    providerSpec,
} from "@intentic/sandbox-contract";
import { ensureFreshToken, replaceRejectedToken } from "../../runtimes/claude/claude-credentials.js";
import type { Services } from "../../composition.js";
import { serviceabilities } from "../../usage/serviceability/serviceability.js";
import { opt } from "../../opt.js";
import { goneAccountMessage, resolveRoute, type RouteResult } from "./routes/model-routes.js";
import type { TurnLimit } from "../../usage/serviceability/fleet-limit.js";
import type { HarnessCredential } from "./agent-request.js";
import { containerKeyEnv } from "../../seams/sealed-env.js";

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
                ANTHROPIC_BASE_URL: credential.gateway ?? credential.baseUrl,
                ANTHROPIC_AUTH_TOKEN: credential.authToken,
                ...(model !== undefined ? routedModelEnv(model) : {}),
            };
        case "claude-oauth":
            return { CLAUDE_CODE_OAUTH_TOKEN: credential.token, ...(credential.gateway !== undefined ? { ANTHROPIC_BASE_URL: credential.gateway } : {}) };
        // The container's own key, handed over by name: the daemon's environment no longer holds it (sealed-env.ts).
        case "container":
            return { ...containerKeyEnv("claude"), ...(credential.gateway !== undefined ? { ANTHROPIC_BASE_URL: credential.gateway } : {}) };
    }
};

// Behind the privacy shield the CLI's own reporting is switched off too (error reports and telemetry carry excerpts of
// what it was doing, and go to the CLI vendor's own services, past the gateway).
const shieldedEnv = (credential: HarnessCredential): Record<string, string> =>
    credential.gateway !== undefined
        ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_TELEMETRY: "1" }
        : {};

// Env for a Claude Code harness process. `helper` is a sealed request rather than a turn (agent-request.ts
// `policy.sealed`): a turn tolerates waiting (resumable), a helper should fail fast.
export const harnessEnv = (
    credential: HarnessCredential,
    options: { readonly model?: string | undefined; readonly helper?: boolean } = {},
): Record<string, string> => ({
    IS_SANDBOX: "1",
    // Turn-only: rides out provider blips via retries instead of dying and resuming; helpers and the trial fail fast.
    ...(options.helper === true || credential.kind === "trial" ? {} : { CLAUDE_CODE_RETRY_WATCHDOG: "1" }),
    ...credentialEnv(credential, options.model),
    ...shieldedEnv(credential),
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

// Validates a routed model pick against the live catalog; context-budget.ts budgets against the same model this sends.
export { routedModel } from "./routes/model-routes.js";

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
    | "privacyShield"
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

// A route the harness can take, as the credentials it carries: the URL and bearer (Anthropic Messages, so the base with
// no version path), whose account answered, whose allowance it spends, and whether it is the trial.
const harnessOfRoute = (result: RouteResult): HarnessCredentialsResult => {
    if (!result.ok) {
        return result;
    }
    const { route } = result;
    return {
        ok: true,
        credentials: {
            endpoint: { baseUrl: `${route.endpoint.base}${route.endpoint.path}`, authToken: route.endpoint.token, model: route.model },
            ...opt("account", route.account),
            ...opt("allowance", route.allowance),
            ...opt("trial", route.trial),
        },
    };
};

// Why a provider that only runs on its own runtime refuses the Claude Code harness, where there is more to say than that.
const OWN_RUNTIME_ONLY: Readonly<Record<string, string>> = {
    gemini: "Gemini doesn't run under the Claude Code harness, Google refuses that loop. It runs on its own runtime instead.",
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
    // An endpoint, a minted key or the translator: a route on the Claude Code loop (routes/model-routes.ts).
    const endpointId = input.agent === undefined ? undefined : endpointIdOf(input.agent);
    if (input.agent !== undefined && endpointId !== undefined) {
        return harnessOfRoute(await resolveRoute(services, { provider: input.agent, loop: "claude-code", model: input.model }));
    }
    // A provider that doesn't offer the Claude Code loop runs only on its own, so it has no credential here.
    const spec = input.agent === undefined ? undefined : providerSpec(input.agent);
    if (spec !== undefined && !loopsOf(spec.id).includes("claude-code")) {
        return {
            ok: false,
            message: OWN_RUNTIME_ONLY[spec.id] ?? `${spec.label} doesn't run under the Claude Code harness. It runs on its own runtime instead.`,
        };
    }
    if (spec !== undefined && (spec.auth.kind === "minted" || spec.auth.kind === "translator")) {
        return harnessOfRoute(await resolveRoute(services, { provider: spec.id, loop: "claude-code", account: input.account, model: input.model }));
    }
    // An unnamed account is picked by the one serviceability rule (usage/serviceability.ts); a named account is never
    // filtered here. Routing decided it before this: a conversation's remembered account is moved off one that cannot
    // serve where the turn is planned (providers/accounts/blocked-account.ts), so a named account is a choice made for
    // this turn, or the ready account the turn was moved to. The only account there is runs whatever its state: a
    // failure now explains itself, unlike a stale verdict.
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
