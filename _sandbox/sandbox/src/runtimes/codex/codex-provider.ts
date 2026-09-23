import { join } from "node:path";
import type { AgentEvent, AgentTurn, Capability } from "@intentic/sandbox-contract";
import type { Config } from "../../env.config.js";
import { browserFields } from "../../browser/tools/browser-fields.js";
import { browserPrepareBridge } from "../../browser/tools/browser-prepare.js";
import { browserServersOf } from "../../browser/tools/browser-tools.js";
import {
    attemptProbe,
    armPlan,
    type AgentAdapter,
    healthReady,
    healthUnavailable,
    healthUnknown,
    type TurnArmPlan,
    type TurnContext,
} from "../../agent/providers/adapter.js";
import type { AgentRequest, CodexCredential } from "../../agent/providers/agent-request.js";
import { opt } from "../../opt.js";
import { withAttachments } from "../../agent/prompt/attachment-note.js";
import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../../agent/providers/provider-module.js";
import { connectedTranslatorProviders } from "../../agent/providers/translator.js";
import type { Services } from "../../composition.js";
import { turnPersona } from "../../personas/personas.js";
import { onPath } from "../../platform/boot/on-path.js";
import { codexThreadExists } from "../../sessions/codex-sessions.js";
import { createCodexAgent } from "./codex-agent.js";
import { type CodexCatalog, createCodexCatalog } from "./codex-catalog.js";
import { writeCodexConfig } from "./codex-config.js";
import { codexReadiness } from "./codex-readiness.js";

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

export const createCodexSlice = (input: { readonly config: Config; readonly authRoot: string }): CodexSlice => {
    // Base dir for the sandbox-wide CODEX_HOME; also the adapter's OPENAI_API_KEY-fallback default home.
    const codexHome = join(input.authRoot, "codex");
    return {
        codexModels: createCodexCatalog(input.config, codexHome),
        codexHome,
        codexThreadExists: (threadId) => codexThreadExists(codexHome, threadId),
        codexAgent: createCodexAgent({ codexHome }),
    };
};

// What a native Codex turn is planned from: the translator's accounts, the catalog, and the browser bridge.
export type CodexPlanDeps = Pick<Services, "browserBridgeToken" | "cliProxy" | "codexAgent" | "codexModels" | "config" | "workspace">;

// Native Codex turns ride app-server behind the translator, with process-backed MCP servers from the persona-filtered
// manifest. Mid-turn steering rides a real queue (`turn/steer`), like Pi's.
export const planCodexTurn = async (
    services: CodexPlanDeps,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Promise<TurnArmPlan> => {
    // The subscription via the translator is the credential; the container OPENAI_API_KEY is the only fallback.
    const translatorReady = services.config.translator.url !== "" && (await services.cliProxy.accounts()).codex.length > 0;
    if (!translatorReady && services.config.openaiApiKey === "") {
        return {
            ok: false,
            code: "subscription-required",
            message:
                services.config.translator.url === ""
                    ? "This sandbox has no model translator, so Codex can't run here. Run a sandbox built from the published image."
                    : "Connect your ChatGPT subscription in Sandbox ▸ Agent to run Codex.",
        };
    }
    // Empty model resolves the catalog default (discovery, never empty); an explicit one rides through as-is.
    const persona = context.persona ?? turnPersona({ personas: [], actsAs: undefined, unattended: false });
    const [model, browser] = await Promise.all([
        input.model !== undefined && input.model !== ""
            ? Promise.resolve(input.model)
            : services.codexModels.models().then((catalog) => catalog.default),
        // Plan emulation restarts app-server between review and execution; a fresh process rereads the same manifest.
        browserServersOf(granted, services.workspace.root, browserPrepareBridge(services), persona.powers.browser, input.conversationId),
    ]);
    const request: AgentRequest<CodexCredential> = {
        ...context.base,
        spec: { ...context.base.spec, model, ...opt("steering", context.steering) },
        tools: { ...context.base.tools, ...browserFields(services.workspace.root, browser) },
        // Subscription turns use the translator endpoint with a fixed bearer; the dev path falls to Codex's own key.
        credential: translatorReady
            ? { kind: "codex-endpoint", baseUrl: services.config.translator.url, authToken: services.config.translator.token }
            : { kind: "container" },
    };
    // Attribution key: the shared subscription serving every Codex turn, else undefined for the api-key fallback.
    return armPlan(services.codexAgent, withAttachments(request, context.attachmentPaths), translatorReady ? "codex-subscription" : undefined);
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
    // One CODEX_HOME serves every turn, so a thread lookup needs no cwd.
    holdsSession: (services, sessionId) => services.codexThreadExists(sessionId),
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
    ready: async (services, shared) => services.config.translator.url !== "" && (await shared.translatorAccounts()).codex.length > 0,
    // Writes CODEX_HOME's config.toml at boot, an authoritative overwrite. Selects the translator provider only when
    // its binary is on PATH: TRANSLATOR_URL alone is set on every image, including ones with nothing listening on it.
    boot: (services, role, logger) => {
        void (async () => {
            if (!role.roots) {
                return;
            }
            const translatorUrl = (await onPath("cli-proxy-api")) ? services.config.translator.url : "";
            await writeCodexConfig(services.codexHome, translatorUrl);
        })().catch((error: unknown) => logger.warn({ err: error }, "codex config not written"));
    },
    packs: async (services) => ((await codexConnected(services)) ? ["codex"] : []),
    // One auth file per connected account in the cliproxy auth-dir; its filename doubles as the entry id.
    secretEntries: async (_services, shared) =>
        (await shared.translatorAccounts()).codex.map((account) =>
            providerAccountEntry("codex", "ChatGPT", account.name, account.label, authStateRelPath("cliproxy")),
        ),
};
