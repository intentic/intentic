import { join } from "node:path";
import type { AgentTurn, Capability } from "@intentic/sandbox-contract";
import type { Config } from "../../env.config.js";
import { browserOutputDir } from "../../browser/cast/browser-artifacts.js";
import { browserServersOf } from "../../browser/tools/browser-tools.js";
import { attemptProbe, type AgentAdapter, healthReady, healthUnavailable, healthUnknown } from "../../agent/providers/adapter.js";
import { withAttachments } from "../../agent/prompt/attachment-note.js";
import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../../agent/providers/provider-module.js";
import { connectedTranslatorProviders } from "../../agent/providers/translator.js";
import type { TurnContext, TurnPlan } from "../../agent/run/turn/turn-plan.js";
import type { Services } from "../../composition.js";
import { turnPersona } from "../../personas/personas.js";
import { onPath } from "../../platform/boot/on-path.js";
import { codexThreadExists } from "../../sessions/codex-sessions.js";
import { createCodexAgent } from "./codex-agent.js";
import { type CodexCatalog, createCodexCatalog } from "./codex-catalog.js";
import { writeCodexConfig } from "./codex-config.js";
import { codexReadiness } from "./codex-readiness.js";

// Everything Codex contributes to the daemon, aggregated by the provider registry (agent/provider-module.ts); the
// runtime files keep their own jobs.

export interface CodexSlice {
    // Codex's own catalog; a native turn resolves its model here instead of the SDK's rejected gpt-5-codex default.
    readonly codexModels: CodexCatalog;
    // Sandbox-wide CODEX_HOME (sessions + config.toml picking the translator provider); the adapter's default.
    readonly codexHome: string;
    // Whether a thread's rollout exists in CODEX_HOME; false opens a fresh thread on resume instead of failing.
    readonly codexThreadExists: (threadId: string) => Promise<boolean>;
    readonly codexAgent: Services["agent"];
}

export const createCodexSlice = (input: { readonly config: Config; readonly authRoot: string }): CodexSlice => {
    // Base dir for the sandbox-wide CODEX_HOME; also the adapter's OPENAI_API_KEY-fallback default home.
    const codexHome = join(input.authRoot, "codex");
    return {
        codexModels: createCodexCatalog(input.config, join(codexHome, "models.json")),
        codexHome,
        codexThreadExists: (threadId) => codexThreadExists(codexHome, threadId),
        codexAgent: createCodexAgent({ codexHome }),
    };
};

// Native Codex turns ride app-server behind the translator, with process-backed MCP servers from the persona-filtered
// manifest. Mid-turn steering rides a real queue (`turn/steer`), like Pi's.
export const planCodexTurn = async (
    services: Services,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Promise<TurnPlan> => {
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
        browserServersOf(granted, services.workspace.root, persona.powers.browser, input.conversationId),
    ]);
    const withModel = { ...context.base, model, ...(context.steering !== undefined ? { steering: context.steering } : {}) };
    // Subscription turns use the translator endpoint with a fixed bearer; the dev path falls to Codex's own key.
    const withAuth = translatorReady
        ? { ...withModel, codexEndpoint: { baseUrl: services.config.translator.url, authToken: services.config.translator.token } }
        : withModel;
    const withBrowser =
        Object.keys(browser.servers).length === 0
            ? withAuth
            : {
                  ...withAuth,
                  sdkServers: browser.servers,
                  browserOutputDir: browserOutputDir(services.workspace.root),
                  browserPorts: browser.ports,
                  browserPasskeys: browser.passkeys,
                  browserAccounts: browser.accounts,
              };
    return {
        ok: true,
        run: services.codexAgent,
        // Attribution key: the shared subscription serving every Codex turn, else undefined for the api-key fallback.
        ...(translatorReady ? { account: "codex-subscription" } : {}),
        request: withAttachments(withBrowser, context.attachmentPaths),
    };
};

const CODEX_ADAPTER: AgentAdapter<"codex"> = {
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
export const codexConnected = async (services: Services): Promise<boolean> =>
    services.config.openaiApiKey !== "" || (await connectedTranslatorProviders(services.authRoot)).has("codex");

export const codexProvider: ProviderModule = {
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
