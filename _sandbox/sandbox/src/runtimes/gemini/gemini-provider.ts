import { join } from "node:path";
import { type AgentTurn, PROVIDER_ACCESS } from "@intentic/sandbox-contract";
import { attemptProbe, type AgentAdapter, healthReady, healthUnavailable, healthUnknown } from "../../agent/providers/adapter.js";
import { withAttachments } from "../../agent/prompt/attachment-note.js";
import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../../agent/providers/provider-module.js";
import type { TurnContext, TurnPlan } from "../../agent/run/turn/turn-plan.js";
import type { Services } from "../../composition.js";
import type { Config } from "../../env.config.js";
import { createGrokAgent, createGrokRunner } from "../grok/grok-agent.js";
import { OPENCODE_GEMINI_PROVIDER, openCodeBinaryMissing, type OpenCodeService } from "../grok/opencode.js";
import { onPath } from "../../platform/boot/on-path.js";
import { createGeminiCatalog, type GeminiCatalog } from "./gemini-catalog.js";
import { geminiOneShot } from "./gemini-one-shot.js";

// Everything Gemini contributes to the daemon, aggregated by the provider registry. Its native runtime is Grok's
// OpenCode loop pointed at a different backend, and its credential is the translator's, so this module owns only the
// catalog and the loop binding.

export interface GeminiSlice {
    // Never empty (discovery → persisted → seed); OpenCode's server config also reads it to register ids at boot.
    readonly geminiModels: GeminiCatalog;
    // Same OpenCode loop grokAgent runs on, just a different backend; built from the same factory, not a separate
    // adapter.
    readonly geminiAgent: Services["agent"];
}

export const createGeminiSlice = (input: {
    readonly config: Config;
    readonly authRoot: string;
    readonly openCode: OpenCodeService;
}): GeminiSlice => ({
    geminiModels: createGeminiCatalog(input.config, join(input.authRoot, "gemini", "models.json")),
    // One warm OpenCode server serves Grok and Gemini both; only the model backend the prompt names differs.
    geminiAgent: createGrokAgent(createGrokRunner(input.openCode), OPENCODE_GEMINI_PROVIDER),
});

// Gemini on the same OpenCode loop Grok runs on, pointed at the translator instead of xAI; OpenCode holds no
// credential, CLIProxyAPI does, the same as a routed turn. Exists because the Claude Code loop's baked-in identity line
// gets every Google account refused as a false quota error.
export const planGeminiTurn = async (services: Services, input: AgentTurn, context: TurnContext): Promise<TurnPlan> => {
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
    const catalog = await services.geminiModels.models();
    // Absent and empty both mean the catalog default: the wire allows `model: ""`, and nothing was pinned.
    const pinned = input.model === undefined || input.model === "" ? undefined : input.model;
    // A pin this channel has stopped offering ends the turn rather than running on the catalog default. Substituting
    // spends a model the user did not choose, on its own separate allowance, and says so nowhere; the code holds the
    // message, reloads the picker, and leaves the choice where it belongs. The catalog keeps a de-listed row for its
    // own grace window (model-catalog.ts), so reaching this means the channel has stopped serving it, not blinked.
    if (pinned !== undefined && !catalog.models.some((entry) => entry.id === pinned)) {
        return {
            ok: false,
            code: "model-unavailable",
            message: `Google is no longer offering ${pinned}, and this chat is pinned to it. Pick another model for this chat, or send again if it comes back.`,
        };
    }
    // Never empty, so this always resolves.
    const model = pinned ?? catalog.default;
    return {
        ok: true,
        run: services.geminiAgent,
        request: withAttachments({ ...context.base, model }, context.attachmentPaths),
    };
};

// Own adapter row, not a second provider on Grok's, since health is keyed by runtime: sharing one entry would grey
// Gemini out over a missing xAI sign-in, or Grok out over a missing Google account. OpenCode holds no Gemini credential
// (CLIProxyAPI does); the binary is Grok's, so if `opencode` is missing, neither runs.
const OPENCODE_GEMINI_ADAPTER: AgentAdapter<"opencode-gemini"> = {
    runtime: "opencode-gemini",
    oneShot: geminiOneShot,
    preflight: (services, input, context) => planGeminiTurn(services, input, context),
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
        return (await onPath("opencode")) ? healthReady() : healthUnavailable(openCodeBinaryMissing("Google"));
    },
    holdsSession: (services, sessionId, cwd) => services.openCode.sessionExists(sessionId, cwd),
};

export const geminiProvider: ProviderModule = {
    id: "gemini",
    adapters: [OPENCODE_GEMINI_ADAPTER],
    catalog: (services) => services.geminiModels.models(),
    ready: async (services, shared) => services.config.translator.url !== "" && (await shared.translatorAccounts()).gemini.length > 0,
    // No boot or pack of its own: Grok's loop, translatorWanted's credential, catalog needs nothing started.
    secretEntries: async (_services, shared) =>
        (await shared.translatorAccounts()).gemini.map((account) =>
            providerAccountEntry("gemini", "Gemini", account.name, account.label, authStateRelPath("cliproxy")),
        ),
};
