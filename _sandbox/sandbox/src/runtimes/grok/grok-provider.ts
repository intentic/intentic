import type { AgentTurn } from "@intentic/sandbox-contract";
import { attemptProbe, type AgentAdapter, healthReady, healthUnavailable, healthUnknown } from "../../agent/providers/adapter.js";
import { withAttachments } from "../../agent/prompt/attachment-note.js";
import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../../agent/providers/provider-module.js";
import type { TurnContext, TurnPlan } from "../../agent/run/turn/turn-plan.js";
import type { Services } from "../../composition.js";
import { createGrokAgent, createGrokRunner } from "./grok-agent.js";
import { engineBinary } from "../../engines/engine-resolve.js";
import { openCodeBinaryMissing, type OpenCodeService } from "./opencode.js";
import { grokAccountDoor } from "./grok-accounts.js";

// Everything Grok contributes to the daemon, aggregated by the provider registry (agent/provider-module.ts). The slice
// is one member: OpenCode is core rather than Grok's own, since one warm `opencode serve` also serves Gemini and the
// delegation watchers.

export interface GrokSlice {
    readonly grokAgent: Services["agent"];
}

export const createGrokSlice = (openCode: OpenCodeService): GrokSlice => ({
    grokAgent: createGrokAgent(createGrokRunner(openCode)),
});

// Grok rides OpenCode with xAI subscription OAuth; gated on OpenCode's own connection view. Claude-only fields
// (plugins, MCP tools, thinking) don't apply.
export const planGrokTurn = async (services: Services, input: AgentTurn, context: TurnContext): Promise<TurnPlan> => {
    if (!(await services.openCode.connected("xai"))) {
        return {
            ok: false,
            message: "No Grok account connected, sign in with your xAI (SuperGrok/X Premium) account in Setup before chatting.",
        };
    }
    // OpenCode's own default is a retired id xAI rejects, so this resolves from the daemon's catalog instead (never
    // empty): keeps the pinned model if valid, else the catalog default. A stale id self-heals mid-turn via xAI's "Did
    // you mean" rejection.
    const catalog = await services.openCode.xaiModels();
    const valid = new Set(catalog.models.map((entry) => entry.id));
    const model = input.model !== undefined && valid.has(input.model) ? input.model : catalog.default;
    return {
        ok: true,
        run: services.grokAgent,
        // OpenCode holds one xAI auth, so the single Grok account is "xai" (see grok-accounts.ts).
        account: "xai",
        // Overrides base's input.model with the validated id; the adapter folds attachment paths into the prompt.
        request: withAttachments({ ...context.base, model }, context.attachmentPaths),
    };
};

const OPENCODE_ADAPTER: AgentAdapter<"opencode"> = {
    runtime: "opencode",
    preflight: (services, input, context) => planGrokTurn(services, input, context),
    health: async (services) => {
        const connected = await attemptProbe(() => services.openCode.connected("xai"));
        if (connected === undefined) {
            return healthUnknown();
        }
        if (!connected) {
            return healthUnavailable("Sign in with your xAI (SuperGrok/X Premium) account in Setup.");
        }
        // Signed in, but OpenCode is a feature pack this image may not carry; only a rebuild or an Environment-card
        // install fixes it.
        return (await engineBinary("opencode", "opencode")) !== undefined ? healthReady() : healthUnavailable(openCodeBinaryMissing("Grok"));
    },
    holdsSession: (services, sessionId, cwd) => services.openCode.sessionExists(sessionId, cwd),
};

export const grokProvider: ProviderModule = {
    id: "grok",
    accounts: grokAccountDoor,
    adapters: [OPENCODE_ADAPTER],
    catalog: (services) => services.openCode.xaiModels(),
    // Feeds the routed pickers (Grok under the Claude Code harness); the translator's question, not OpenCode's (native
    // account health is above).
    ready: async (services, shared) => services.config.translator.url !== "" && (await shared.translatorAccounts()).grok.length > 0,
    // Warms the OpenCode server at boot: a cold spawn can stall the /events heartbeat past the browser's watchdog. Runs
    // only if xAI is already connected; ensure() is idempotent, so the first interactive call reuses this client.
    boot: (services, _role, logger) => {
        void (async () => {
            if (!(await services.openCode.connected("xai"))) {
                return;
            }
            if ((await engineBinary("opencode", "opencode")) === undefined) {
                logger.info("opencode: the binary is not in this image, add it by rebuilding from the Environment card");
                return;
            }
            await services.openCode.client();
        })().catch((error: unknown) => logger.warn({ err: error }, "opencode warmup failed, first grok connect boots it lazily"));
    },
    // OpenCode is Grok's credential store too: `connected` reads the auth.json a device sign-in wrote, on disk whether
    // or not a server is up.
    packs: async (services) => ((await services.openCode.connected("xai")) ? ["opencode"] : []),
    // OpenCode holds one xAI auth per data dir, so Grok is a single fixed row rather than a list.
    secretEntries: async (services) =>
        (await services.openCode.connected("xai")) ? [providerAccountEntry("grok", "Grok", "xai", "Grok", authStateRelPath("opencode"))] : [],
};
