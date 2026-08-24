import { join } from "node:path";
import type { AgentTurn } from "@intentic/sandbox-contract";
import { attemptProbe, type AgentAdapter, healthReady, healthUnavailable, healthUnknown } from "../agent/adapter.js";
import { withAttachments } from "../agent/attachment-note.js";
import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../agent/provider-module.js";
import type { TurnContext, TurnPlan } from "../agent/turn-plan.js";
import type { Services } from "../composition.js";
import type { Config } from "../env.config.js";
import { createGrokAgent, createGrokRunner } from "../grok/grok-agent.js";
import { OPENCODE_GEMINI_PROVIDER, openCodeBinaryMissing, type OpenCodeService } from "../grok/opencode.js";
import { onPath } from "../platform/on-path.js";
import { createGeminiCatalog, type GeminiCatalog } from "./gemini-catalog.js";

/* EVERYTHING GEMINI CONTRIBUTES TO THE DAEMON, aggregated by the provider registry (agent/provider-module.ts
 * is the seam). Gemini is the module with the strangest shape, and honestly so: its native runtime is GROK'S
 * OpenCode loop pointed at a different backend, and its credential is the TRANSLATOR'S, so this module owns
 * only what is genuinely Gemini's — the catalog, and the loop binding. */

export interface GeminiSlice {
    // Gemini's model catalog (discovery → persisted → seed floor, never empty). Held directly as well as in
    // the shared record because OpenCode's server config reads it too: the translator re-serves these ids as
    // an OpenAI-compatible backend, and the server registers them at boot.
    readonly geminiModels: GeminiCatalog;
    // Gemini's native runtime: the SAME OpenCode loop grokAgent runs on, bound to a different model backend,
    // which is why it is built from the same factory rather than being a separate adapter file.
    readonly geminiAgent: Services["agent"];
}

export const createGeminiSlice = (input: { readonly config: Config; readonly authRoot: string; readonly openCode: OpenCodeService }): GeminiSlice => ({
    geminiModels: createGeminiCatalog(input.config, join(input.authRoot, "gemini", "models.json")),
    // One warm OpenCode server serves Grok and Gemini both, so the runner is the same shape; only the model
    // backend the prompt names differs (opencode.ts registers it as an OpenAI-compatible provider on the
    // translator).
    geminiAgent: createGrokAgent(createGrokRunner(input.openCode), OPENCODE_GEMINI_PROVIDER),
});

/* GEMINI ON ITS NATIVE RUNTIME, the same OpenCode loop Grok runs on, pointed at the translator instead of at
 * xAI. The credential question is therefore the one a ROUTED turn asks, not the one planGrokTurn asks: OpenCode
 * holds nothing for Gemini, CLIProxyAPI holds every Google auth file and balances the fleet behind them.
 *
 * It exists because the Claude Code loop can no longer reach Google. That CLI prepends its own identity line to
 * every request and bakes it into the binary; Google's Antigravity channel refuses on that exact sentence, and
 * reports it as a quota error, so the translator walked all 31 accounts looking for headroom none of them
 * lacked, ~60s a turn. This loop sends OpenCode's prompt, which the block has nothing to match in.
 *
 * The model is resolved from the same catalog the Claude Code path uses, so a pin survives a harness switch. */
export const planGeminiTurn = async (services: Services, input: AgentTurn, context: TurnContext): Promise<TurnPlan> => {
    if (services.config.translator.url === "") {
        return {
            ok: false,
            message: "This sandbox has no model translator, so Gemini can't run here. Run a sandbox built from the published image.",
        };
    }
    if ((await services.cliProxy.accounts()).gemini.length === 0) {
        return { ok: false, message: "Connect your Google account in Sandbox ▸ Agent to run Gemini here." };
    }
    // Never empty (discovery → persisted → seed floor), so this always resolves: keep the pinned model while the
    // catalog still offers it, else take the catalog's default, the same rule routedModel applies.
    const catalog = await services.geminiModels.models();
    const model = input.model !== undefined && catalog.models.some((entry) => entry.id === input.model) ? input.model : catalog.default;
    return {
        ok: true,
        run: services.geminiAgent,
        request: withAttachments({ ...context.base, model }, context.attachmentPaths),
    };
};

/* Gemini's native runtime, the same OpenCode loop, a different model backend and an entirely different
 * credential question. It is its own row rather than a second provider on the grok adapter because health is
 * keyed by runtime (adapter-health.ts): sharing one entry would let a missing xAI sign-in grey Gemini out of
 * the picker, and a missing Google account grey out Grok.
 *
 * OpenCode stores nothing for Gemini. CLIProxyAPI holds Google's auth files and balances them, so the
 * credential half asks the translator, exactly as a routed turn does. The binary half is Grok's, unchanged: one
 * `opencode serve` serves both, so if it is missing neither can run. */
const OPENCODE_GEMINI_ADAPTER: AgentAdapter<"opencode-gemini"> = {
    runtime: "opencode-gemini",
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
            return healthUnavailable("Connect your Google account in Sandbox ▸ Agent.");
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
    // No boot and no pack of its own: the loop is Grok's binary (its module warms it), the credential is the
    // translator's (its pack rides translatorWanted), and the catalog needs nothing started.
    secretEntries: async (_services, shared) =>
        (await shared.translatorAccounts()).gemini.map((account) =>
            providerAccountEntry("gemini", "Gemini", account.name, account.label, authStateRelPath("cliproxy")),
        ),
};
