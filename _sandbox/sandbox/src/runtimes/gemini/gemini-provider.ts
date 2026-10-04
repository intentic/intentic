import { join } from "node:path";
import { type AgentEvent, type AgentTurn, type Capability, PROVIDER_ACCESS } from "@intentic/sandbox-contract";
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
import type { AgentRequest, ContainerCredential } from "../../agent/providers/agent-request.js";
import { withAttachments } from "../../agent/prompt/attachment-note.js";
import { releasingMounts } from "../../agent/tools/turn-mounts.js";
import { turnToolsOf, type TurnToolsDeps } from "../../agent/tools/turn-tools.js";
import {
    engineMissing,
    enginesReady,
    type ProviderModule,
    translatorAccountEntries,
    translatorReady,
} from "../../agent/providers/provider-module.js";
import type { Services } from "../../composition.js";
import type { Config } from "../../env.config.js";
import { createGeminiCatalog, type GeminiCatalog, selectGeminiModelForRequest } from "./gemini-catalog.js";
import { geminiOneShot } from "./gemini-one-shot.js";
import { sharedServerRefusal } from "../../privacy/harness-route.js";

// Everything Gemini contributes, listed in runtimes/runtime-table.ts: the OpenCode loop Grok runs on, on its own backend.

export interface GeminiSlice {
    // Account-verified choices; may be empty. OpenCode also reads this to register exact IDs and modalities.
    readonly geminiModels: GeminiCatalog;
    // Same OpenCode loop grokAgent runs on, just a different backend; built from the same factory, not a separate
    // adapter.
    readonly geminiAgent: (request: AgentRequest<ContainerCredential>) => AsyncGenerator<AgentEvent>;
}

// The loop comes built: one warm OpenCode server serves Grok and Gemini both, only the backend the prompt names differs.
export const createGeminiSlice = (input: {
    readonly config: Config;
    readonly authRoot: string;
    readonly cliProxy: Pick<Services["cliProxy"], "googleModelAvailability">;
    readonly geminiAgent: GeminiSlice["geminiAgent"];
}): GeminiSlice => ({
    geminiModels: createGeminiCatalog(input.config, join(input.authRoot, "gemini", "models.json"), input.cliProxy),
    geminiAgent: input.geminiAgent,
});

// Gemini on the same OpenCode loop Grok runs on, pointed at the translator instead of xAI; OpenCode holds no
// credential, CLIProxyAPI does, the same as a routed turn. Exists because the Claude Code loop's baked-in identity line
// gets every Google account refused as a false quota error.
// What a Gemini turn is planned from: the translator's accounts, the Google catalog it serves, and the turn's MCP mounts.
export type GeminiPlanDeps = TurnToolsDeps & Pick<Services, "cliProxy" | "config" | "geminiAgent" | "geminiModels" | "openCode" | "privacyShield">;

export const planGeminiTurn = async (
    services: GeminiPlanDeps,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Promise<TurnArmPlan> => {
    if (services.config.translator.url === "") {
        return {
            ok: false,
            message: "This sandbox has no model translator, so Gemini can't run here. Run a sandbox built from the published image.",
        };
    }
    if ((await services.cliProxy.accounts()).gemini.length === 0) {
        // Reads the wording off the provider's spec row, matching what the connect prompt and picker already say.
        return { ok: false, message: `Connect your ${PROVIDER_ACCESS.gemini.requirement} in Sandbox ▸ Agent to run Gemini here.` };
    }
    // This guard reads one advertisement/availability snapshot; neither persisted metadata nor a global model
    // definition can authorize an unavailable pin. Refuse before privacy/runtime probes or turn-tool leases.
    const selected = await selectGeminiModelForRequest(services.geminiModels, input.model, context.base.signal);
    context.base.signal.throwIfAborted();
    if (!selected.ok) {
        return selected;
    }
    const refused = await sharedServerRefusal(services.privacyShield, services.openCode.shielded, "gemini").catch((error: unknown) =>
        error instanceof Error ? error.message : "the privacy shield's policy could not be read",
    );
    if (refused !== undefined) {
        return { ok: false, message: refused };
    }
    const model = selected.model;
    // The turn's remote MCP servers, as Grok's and Codex's; leased last, once nothing can refuse the turn, since only the
    // loop it arms releases it.
    const mounted = await turnToolsOf(services, granted, {
        conversationId: input.conversationId,
        anonymousBrowser: context.persona?.powers.browser ?? true,
        extensions: context.persona?.powers.extensions,
    });
    return armPlan(
        releasingMounts(services.geminiAgent, mounted),
        withAttachments(
            {
                ...context.base,
                spec: { ...context.base.spec, model },
                tools: mounted.tools.length > 0 ? { ...context.base.tools, remote: mounted.tools } : context.base.tools,
                credential: { kind: "container" },
            },
            context.attachmentPaths,
        ),
    );
};

// Own adapter row, not a second provider on Grok's, since health is keyed by runtime: sharing one entry would grey
// Gemini out over a missing xAI sign-in, or Grok out over a missing Google account. OpenCode holds no Gemini credential
// (CLIProxyAPI does); the binary is Grok's, so if `opencode` is missing, neither runs.
// What the Gemini adapter reads: its arm's deps, and the OpenCode sessions a resume and the one-shot helper ask.
export type GeminiAdapterDeps = GeminiPlanDeps & Pick<Services, "openCode">;

const OPENCODE_GEMINI_ADAPTER: AgentAdapter<"opencode-gemini", GeminiAdapterDeps> = {
    runtime: "opencode-gemini",
    oneShot: geminiOneShot,
    preflight: (services, input, context, granted) => planGeminiTurn(services, input, context, granted),
    health: async (services) => {
        if (services.config.translator.url === "") {
            return healthUnavailable("This sandbox has no model translator: run one built from the published image to use Gemini.");
        }
        const accounts = await attemptProbe(() => services.cliProxy.accounts());
        if (accounts === undefined) {
            return healthUnknown();
        }
        if (accounts.gemini.length === 0) {
            return healthUnavailable(`Connect your ${PROVIDER_ACCESS.gemini.requirement} in Sandbox ▸ Agent.`);
        }
        return (await enginesReady(geminiProvider)) ? healthReady() : healthUnavailable(engineMissing("the OpenCode CLI", "Google"));
    },
    holdsSession: (services, sessionId, cwd) => services.openCode.sessionExists(sessionId, cwd),
};

export const geminiProvider: ProviderModule<GeminiAdapterDeps> = {
    id: "gemini",
    engines: ["opencode"],
    adapters: [OPENCODE_GEMINI_ADAPTER],
    catalog: (services) => services.geminiModels.models(),
    ready: translatorReady("gemini"),
    // No boot or pack of its own: Grok's loop, translatorWanted's credential, catalog needs nothing started.
    secretEntries: translatorAccountEntries("gemini", "Gemini"),
};
