import { join } from "node:path";
import type { AgentTurn, Capability } from "@intentic/sandbox-contract";
import type { Config } from "../env.config.js";
import { browserOutputDir } from "../browser/browser-artifacts.js";
import { browserServersOf } from "../browser/browser-tools.js";
import { attemptProbe, type AgentAdapter, healthReady, healthUnavailable, healthUnknown } from "../agent/adapter.js";
import { withAttachments } from "../agent/attachment-note.js";
import { AGENT_SIGNALS_DIR } from "../agent/delegation-signals.js";
import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../agent/provider-module.js";
import { connectedTranslatorProviders } from "../agent/translator.js";
import type { TurnContext, TurnPlan } from "../agent/turn-plan.js";
import type { Services } from "../composition.js";
import { turnPersona } from "../personas/personas.js";
import { onPath } from "../platform/on-path.js";
import { codexThreadExists } from "../sessions/codex-sessions.js";
import { createCodexAgent } from "./codex-agent.js";
import { type CodexCatalog, createCodexCatalog } from "./codex-catalog.js";
import { writeCodexConfig } from "./codex-config.js";
import { codexReadiness } from "./codex-readiness.js";

/* EVERYTHING CODEX CONTRIBUTES TO THE DAEMON, aggregated by the provider registry (agent/provider-module.ts
 * is the seam). The runtime files keep their jobs; this holds the rows the shared tables used to hold. */

export interface CodexSlice {
    // OpenAI/Codex's catalog, held directly as well as in the shared record: a native Codex turn resolves its
    // model here so it never sends the SDK's rejected gpt-5-codex default, and a turn's self-heal `record`s the
    // ids the subscription proved valid. Neither is a question the shared record asks.
    readonly codexModels: CodexCatalog;
    // The sandbox-wide CODEX_HOME (sessions + the config.toml selecting the translator provider). The codex
    // adapter defaults to it, and the Claude agent's shell delegation points `codex` at it.
    readonly codexHome: string;
    // Whether a Codex thread's rollout still exists in the sandbox-wide CODEX_HOME, so a resume of a
    // deleted/lost thread opens a fresh thread seeded from the record instead of failing opaquely mid-turn.
    readonly codexThreadExists: (threadId: string) => Promise<boolean>;
    readonly codexAgent: Services["agent"];
}

export const createCodexSlice = (input: { readonly config: Config; readonly authRoot: string }): CodexSlice => {
    // Base dir under which the sandbox-wide CODEX_HOME lives; also the adapter's default (the OPENAI_API_KEY
    // fallback home when a turn resolved no account).
    const codexHome = join(input.authRoot, "codex");
    return {
        codexModels: createCodexCatalog(input.config, join(codexHome, "models.json")),
        codexHome,
        codexThreadExists: (threadId) => codexThreadExists(codexHome, threadId),
        codexAgent: createCodexAgent({ codexHome }),
    };
};

// Native Codex turns ride the provider's own app-server behind the translator. Its app-server accepts
// process-backed MCP servers in the per-thread config, so the browser servers are built from the same
// persona-filtered manifest the Claude Code path reads. Daemon-side SDK servers and plugins still belong to
// that richer harness and stay absent here. Mid-turn steering rides through like Pi's: the queue is real
// (`turn/steer`), so the arm hands it over rather than dropping it.
export const planCodexTurn = async (
    services: Services,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Promise<TurnPlan> => {
    // The subscription (via the translator) is the credential; the container OPENAI_API_KEY is the only fallback
    // (a bare dev run with no translator baked).
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
    // Resolve a concrete model so app-server never falls back to the Codex CLI's built-in default
    // (gpt-5-codex), which the subscription can reject. An explicit selection rides through (a stale one
    // self-heals via codex-model-invalid); an empty one resolves the catalog default (discovery → persisted →
    // seed floor, never empty, see codex-catalog).
    const persona = context.persona ?? turnPersona({ personas: [], actsAs: undefined, unattended: false });
    const [model, browser] = await Promise.all([
        input.model !== undefined && input.model !== ""
            ? Promise.resolve(input.model)
            : services.codexModels.models().then((catalog) => catalog.default),
        /* Codex plan emulation closes its app-server while a person reviews the plan, then starts a fresh one
         * for execution. The router spec is restartable, a fresh process rereads the same manifest and the
         * same persisted profiles, so both phases drive the same browsers. */
        browserServersOf(granted, services.workspace.root, persona.powers.browser, input.conversationId),
    ]);
    const withModel = { ...context.base, model, ...(context.steering !== undefined ? { steering: context.steering } : {}) };
    // A subscription-served turn rides the translator's OpenAI-compatible endpoint on the fixed local bearer (the
    // adapter builds the provider block); the dev api-key path uses Codex's own OPENAI_API_KEY default. The
    // default CODEX_HOME (createCodexAgent) serves every turn, no per-turn home. Codex takes attachments
    // structurally: images ride as native local_image inputs, the rest as a file list in the prompt.
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
        // Attribution key: the shared subscription serving all Codex turns, else undefined for the api-key fallback.
        ...(translatorReady ? { account: "codex-subscription" } : {}),
        request: withAttachments(withBrowser, context.attachmentPaths),
    };
};

const CODEX_ADAPTER: AgentAdapter<"codex"> = {
    runtime: "codex",
    preflight: (services, input, context, granted) => planCodexTurn(services, input, context, granted),
    // The same question planCodexTurn refuses on, asked without building a turn, one resolver, so the tooltip
    // and the refusal can never name different reasons (codex-readiness.ts).
    health: async (services) => {
        const readiness = await attemptProbe(() => codexReadiness(services));
        if (readiness === undefined) {
            return healthUnknown();
        }
        return readiness.ok ? healthReady() : healthUnavailable(readiness.detail);
    },
    // One sandbox-wide CODEX_HOME serves every turn (see planCodexTurn), so a thread is looked up without a cwd.
    holdsSession: (services, sessionId) => services.codexThreadExists(sessionId),
};

/* A Codex turn is served by the ChatGPT subscription the translator holds, or, on a bare dev run, by the
 * container's OPENAI_API_KEY. Either way the turn spawns the `codex` CLI, so either one wants the pack. This is
 * the same reachability test planCodexTurn and the shell-delegation note gate on.
 *
 * CONNECTED IS READ FROM DISK, never from the helper it would start (the provider-packs rule): the translator
 * holds this credential, and on a core image the translator binary is absent, so every live probe answers
 * "nothing connected" and would keep the pack out of the very rebuild that installs it. */
export const codexConnected = async (services: Services): Promise<boolean> =>
    services.config.openaiApiKey !== "" || (await connectedTranslatorProviders(services.authRoot)).has("codex");

export const codexProvider: ProviderModule = {
    id: "codex",
    adapters: [CODEX_ADAPTER],
    catalog: (services) => services.codexModels.models(),
    // Ready = the translator holds a ChatGPT subscription. Deliberately NOT the OPENAI_API_KEY fallback: this
    // rung feeds the ROUTED-turn pickers, and the container key serves native turns only.
    ready: async (services, shared) => services.config.translator.url !== "" && (await shared.translatorAccounts()).codex.length > 0,
    /* Write the sandbox-wide CODEX_HOME's config.toml + signal hooks at boot: the `translator` model_provider on
     * the ChatGPT subscription, the default that serves the Claude agent's shell delegation (its freeform
     * `codex exec` can't pass per-turn overrides). Best-effort; authoritative overwrite.
     *
     * "Baked" is the BINARY, not TRANSLATOR_URL. The runner sets that URL on every image, so on a core one it
     * would select a model_provider nothing is listening on and every delegated `codex exec` would fail against
     * a dead port. Empty instead ⇒ Codex's own OPENAI_API_KEY provider, which is the one credential such a
     * sandbox may still have. */
    boot: (services, role, logger) => {
        void (async () => {
            if (!role.roots) {
                return;
            }
            const translatorUrl = (await onPath("cli-proxy-api")) ? services.config.translator.url : "";
            await writeCodexConfig(services.codexHome, translatorUrl, AGENT_SIGNALS_DIR);
        })().catch((error: unknown) => logger.warn({ err: error }, "codex config not written"));
    },
    packs: async (services) => ((await codexConnected(services)) ? ["codex"] : []),
    // One auth file per connected account in the cliproxy auth-dir, its name doubling as the entry id.
    secretEntries: async (_services, shared) =>
        (await shared.translatorAccounts()).codex.map((account) =>
            providerAccountEntry("codex", "ChatGPT", account.name, account.label, authStateRelPath("cliproxy")),
        ),
};
