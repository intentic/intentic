import { join } from "node:path";
import type { AgentEvent, AgentProvider, AgentTurn, Capability } from "@intentic/sandbox-contract";
import type { Config } from "../../env.config.js";
import { releasingMounts } from "../../agent/tools/turn-mounts.js";
import { turnToolsOf, type TurnToolsDeps } from "../../agent/tools/turn-tools.js";
import { browserFields } from "../../browser/tools/browser-fields.js";
import {
    type AgentAdapter,
    armPlan,
    attemptProbe,
    healthReady,
    healthUnavailable,
    healthUnknown,
    type TurnArmPlan,
    type TurnContext,
} from "../../agent/providers/adapter.js";
import type { AgentRequest, CodexCredential } from "../../agent/providers/agent-request.js";
import { opt } from "../../opt.js";
import { withAttachments } from "../../agent/prompt/attachment-note.js";
import { type ProviderModule, translatorAccountEntries, translatorReady } from "../../agent/providers/provider-module.js";
import { connectedTranslatorProviders } from "../../agent/providers/translator.js";
import type { Services } from "../../composition.js";
import { turnPersona } from "../../personas/personas.js";
import { engineReady } from "../../engines/engine-resolve.js";
import { standing } from "../../rules/rules.js";
import { editReviewersOf } from "../../agent/run/harness/harness-hooks.js";
import { turnSecretAccess } from "../../agent/run/harness/harness-servers.js";
import { daemonServersFor, type DaemonServersDeps } from "../daemon-tools/daemon-servers.js";
import { createCodexAgent } from "./codex-agent.js";
import { type CodexCatalog, createCodexCatalog } from "./codex-catalog.js";
import { writeCodexConfig } from "./codex-config.js";
import { codexReadiness } from "./codex-readiness.js";
import { CODEX_BINARY_MISSING, codexBinary } from "./codex-path.js";
import { resolveRoute, type RouteDeps, routeReadiness, routeSlug } from "../../agent/providers/routes/model-routes.js";
import { codexThreadExists } from "./codex-sessions.js";
import { requireRootAgentExecution } from "../../workload/agent-execution.js";

// Everything Codex contributes to the daemon, listed in runtimes/runtime-table.ts; the runtime files keep their own jobs.

export interface CodexSlice {
    // Codex's own catalog; a native turn resolves its model here instead of the SDK's rejected gpt-5-codex default.
    readonly codexModels: CodexCatalog;
    // Sandbox-wide CODEX_HOME (sessions + config.toml picking the translator provider); the adapter's default.
    readonly codexHome: string;
    // Whether a thread's rollout exists in CODEX_HOME; false opens a fresh thread on resume instead of failing.
    readonly codexThreadExists: (threadId: string) => Promise<boolean>;
    readonly codexAgent: (request: AgentRequest<CodexCredential>) => AsyncGenerator<AgentEvent>;
}

export const createCodexSlice = (input: {
    readonly config: Config;
    readonly authRoot: string;
    // What the translator's Codex credentials are registered for, benched or not (CliProxyClient.planModels).
    readonly planModels?: () => Promise<readonly string[]>;
}): CodexSlice => {
    // Base dir for the sandbox-wide CODEX_HOME; also the adapter's OPENAI_API_KEY-fallback default home.
    const codexHome = join(input.authRoot, "codex");
    return {
        codexModels: createCodexCatalog(input.config, codexHome, input.planModels === undefined ? {} : { planModels: input.planModels }),
        codexHome,
        codexThreadExists: (threadId) => codexThreadExists(codexHome, threadId),
        codexAgent: createCodexAgent({ codexHome }),
    };
};

// What a Codex turn is planned from: the translator's accounts, the catalog, the stores behind another provider's route,
// and the turn's MCP mounts.
export type CodexPlanDeps = TurnToolsDeps &
    DaemonServersDeps &
    RouteDeps &
    Pick<Services, "cliProxy" | "codexAgent" | "codexModels" | "config" | "privacyShield" | "workspace" | "sandboxSettings">;

// Which credential a Codex turn runs on, the model it names, and whose account the turn is stamped with: the
// subscription through the translator (behind the privacy shield's gateway where one stands), the container's
// OPENAI_API_KEY, or another provider's route; a refusal when none can serve it. `model` is absent where Codex's own
// catalog decides it (a ChatGPT turn naming none).
type CodexRoute =
    | {
          readonly ok: true;
          readonly credential: CodexCredential;
          readonly model?: string;
          readonly attribution?: string;
      }
    | Extract<TurnArmPlan, { ok: false }>;

const codexRoute = async (services: CodexPlanDeps, input: AgentTurn): Promise<CodexRoute> => {
    // The subscription via the translator is the credential; the container OPENAI_API_KEY is the only fallback.
    const subscribed = services.config.translator.url !== "" && (await services.cliProxy.accounts()).codex.length > 0;
    if (!subscribed && services.config.openaiApiKey === "") {
        return {
            ok: false,
            code: "subscription-required",
            message:
                services.config.translator.url === ""
                    ? "This sandbox has no model translator, so Codex can't run here. Run a sandbox built from the published image."
                    : "Connect your ChatGPT subscription in Sandbox ▸ Agent to run Codex.",
        };
    }
    // The privacy shield stands between Codex and the translator; the API-key fallback talks to OpenAI directly, which
    // nothing here can stand in front of, so while the shield is on it runs only if Codex is trusted.
    try {
        if (subscribed) {
            const gateway = await services.privacyShield.baseUrlFor({ provider: "codex", upstream: services.config.translator.url, conversationId: input.conversationId });
            // Subscription turns use the translator endpoint with a fixed bearer.
            return {
                ok: true,
                attribution: "codex-subscription",
                credential: { kind: "codex-endpoint", baseUrl: gateway ?? services.config.translator.url, authToken: services.config.translator.token },
            };
        }
        const policy = await services.privacyShield.policy();
        if (policy.mode === "on" && !(await services.privacyShield.trusted(policy, "codex", input.conversationId))) {
            return {
                ok: false,
                message:
                    "The privacy shield is on, and Codex here would call OpenAI with the container's own key, past the shield. Connect your ChatGPT subscription so it runs through the translator, or mark Codex as trusted in Sandbox ▸ Privacy shield.",
            };
        }
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "the privacy shield's policy could not be read" };
    }
    // The dev path falls to Codex's own key.
    return { ok: true, credential: { kind: "container" } };
};

// Another provider's model on Codex: its route on the Responses wire (routes/model-routes.ts) as a per-thread provider
// block of its own, behind the privacy shield's gateway where one stands, keyed by the route's own provider.
const hostedCodexRoute = async (services: CodexPlanDeps, input: AgentTurn, provider: AgentProvider): Promise<CodexRoute> => {
    const resolved = await resolveRoute(services, { provider, loop: "codex", account: input.account, model: input.model });
    if (!resolved.ok) {
        return resolved;
    }
    const { route } = resolved;
    let gateway: string | undefined;
    try {
        gateway = await services.privacyShield.baseUrlFor({ provider: route.shield, upstream: route.endpoint.base, conversationId: input.conversationId });
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "the privacy shield's policy could not be read" };
    }
    return {
        ok: true,
        model: route.model,
        ...opt("attribution", route.attribution),
        credential: {
            kind: "codex-endpoint",
            baseUrl: gateway ?? route.endpoint.base,
            authToken: route.endpoint.token,
            hosted: {
                id: `intentic-${routeSlug(provider)}`,
                path: route.endpoint.path,
                ...opt("contextWindow", route.modelRow?.contextWindow),
                ...opt("headers", route.endpoint.headers),
            },
        },
    };
};

// Native Codex turns ride app-server behind the translator, with the turn's remote MCP servers (browsers, machines,
// extension cards, mcp cards) and the daemon's own (ui, accounts, secrets, subagents, watch, deps, diagnostics, code, and
// the `gate` its per-thread hooks call) as http servers in its per-thread config. Mid-turn steering rides a real queue
// (`turn/steer`), like Pi's.
export const planCodexTurn = async (
    services: CodexPlanDeps,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Promise<TurnArmPlan> => {
    // ChatGPT is Codex's own provider; any other rides its route on the Responses wire.
    const provider = input.agent ?? "codex";
    const route = provider === "codex" ? await codexRoute(services, input) : await hostedCodexRoute(services, input, provider);
    if (!route.ok) {
        return route;
    }
    // A hosted route named its model already; for ChatGPT an empty model resolves the catalog default (discovery, never
    // empty), and an explicit one rides through as-is.
    const persona = context.persona ?? turnPersona({ personas: [], actsAs: undefined, unattended: false });
    const [model, mounted, settings] = await Promise.all([
        route.model !== undefined
            ? Promise.resolve(route.model)
            : input.model !== undefined && input.model !== ""
              ? Promise.resolve(input.model)
              : services.codexModels.models().then((catalog) => catalog.default),
        // Plan emulation restarts app-server between review and execution; a fresh process rereads the same manifest.
        turnToolsOf(services, granted, {
            conversationId: input.conversationId,
            anonymousBrowser: persona.powers.browser,
            shell: persona.powers.shell,
            extensions: persona.powers.extensions,
        }),
        context.settings === undefined ? services.sandboxSettings.get() : Promise.resolve(context.settings),
    ]);
    // One secret seam for the turn: the door's typist and code backend resolve through it, and so do the loop's hooks
    // when a shell command names a `{{secret:…}}` reference (codex-hooks.ts).
    const secrets = context.base.tools.secrets ?? turnSecretAccess(services, input, context.base.signal);
    const withSecrets: TurnContext = { ...context, base: { ...context.base, tools: { ...context.base.tools, secrets } } };
    // `gate` on: the thread's own PreToolUse, PostToolUse and Stop hooks call it (codex-hooks.ts).
    const daemon = daemonServersFor(services, { input, context: withSecrets, persona, granted, settings, mounted, gate: true });
    const remote = [...mounted.tools, ...daemon.tools];
    const request: AgentRequest<CodexCredential> = {
        ...context.base,
        spec: { ...context.base.spec, model, ...opt("steering", context.steering) },
        tools: {
            ...context.base.tools,
            secrets,
            ...(remote.length > 0 ? { remote } : {}),
            diagnostics: daemon.diagnostics,
            ...browserFields(services.workspace.root, mounted),
        },
        hooks: {
            ...context.base.hooks,
            relay: daemon.relay,
            // The `file.edited` moment, as the Claude loop's harness runs it, asked after each patch (codex-hooks.ts).
            ...editReviewersOf(services, context, standing(settings.rules, "file.edited")),
        },
        credential: route.credential,
    };
    // Attribution key: the shared subscription serving every ChatGPT turn, a hosted route's account where it picked one,
    // else undefined (the api-key fallback, the translator's pool for another provider).
    return armPlan(releasingMounts(services.codexAgent, mounted), withAttachments(request, context.attachmentPaths), route.attribution);
};

// What the Codex adapter reads: its arm's deps, the readiness answer's, and the thread store a resume asks.
export type CodexAdapterDeps = CodexPlanDeps & Pick<Services, "authRoot" | "codexThreadExists">;

const CODEX_ADAPTER: AgentAdapter<"codex", CodexAdapterDeps> = {
    runtime: "codex",
    preflight: (services, input, context, granted) => planCodexTurn(services, input, context, granted),
    // Same question planCodexTurn answers, without building a turn: one resolver, so the tooltip and the refusal can't
    // disagree (codex-readiness.ts).
    health: async (services) => {
        const readiness = await attemptProbe(() => codexReadiness(services));
        if (readiness === undefined) {
            return healthUnknown();
        }
        return readiness.ok ? healthReady() : healthUnavailable(readiness.detail);
    },
    // Another provider on Codex needs the CLI and its own route, not a ChatGPT sign-in.
    hostHealth: async (services, provider) => {
        if (provider === "codex") {
            return CODEX_ADAPTER.health(services);
        }
        if ((await codexBinary()) === undefined) {
            return healthUnavailable(CODEX_BINARY_MISSING);
        }
        const readiness = await attemptProbe(() => routeReadiness(services, provider, "codex"));
        if (readiness === undefined) {
            return healthUnknown();
        }
        return readiness.ready ? healthReady() : healthUnavailable(readiness.detail);
    },
    // The shared CODEX_HOME is not a domain's store; retain its root lookup, not an unplaced domain probe.
    holdsSession: async (services, sessionId, execution) => {
        requireRootAgentExecution(execution, "Codex's shared session probe");
        return services.codexThreadExists(sessionId);
    },
};

// Reads connection state from disk, never a live probe: on a core image the translator binary is absent, so a probe
// would always say disconnected and block the rebuild that installs it.
export const codexConnected = async (services: Pick<Services, "authRoot" | "config">): Promise<boolean> =>
    services.config.openaiApiKey !== "" || (await connectedTranslatorProviders(services.authRoot)).has("codex");

// What the Codex module reads beyond its adapter: the CODEX_HOME its boot writes the config into.
export type CodexProviderDeps = CodexAdapterDeps & Pick<Services, "codexHome">;

export const codexProvider: ProviderModule<CodexProviderDeps> = {
    id: "codex",
    adapters: [CODEX_ADAPTER],
    catalog: (services) => services.codexModels.models(),
    // Ready means the translator holds a ChatGPT subscription, not the OPENAI_API_KEY fallback: this feeds routed-turn
    // pickers, which the container key can't serve.
    ready: translatorReady("codex"),
    // Overwrites CODEX_HOME's config.toml at boot, naming the translator only when a copy is here: every image sets TRANSLATOR_URL.
    boot: (services, role, logger) => {
        void (async () => {
            if (!role.roots) {
                return;
            }
            const translatorUrl = (await engineReady("translator")) ? services.config.translator.url : "";
            await writeCodexConfig(services.codexHome, translatorUrl);
        })().catch((error: unknown) => logger.warn({ err: error }, "codex config not written"));
    },
    packs: async (services) => ((await codexConnected(services)) ? ["codex"] : []),
    secretEntries: translatorAccountEntries("codex", "ChatGPT"),
};
