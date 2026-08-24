import type { AgentTurn } from "@intentic/sandbox-contract";
import { attemptProbe, type AgentAdapter, healthReady, healthUnavailable, healthUnknown } from "../agent/adapter.js";
import { withAttachments } from "../agent/attachment-note.js";
import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../agent/provider-module.js";
import type { TurnContext, TurnPlan } from "../agent/turn-plan.js";
import type { Services } from "../composition.js";
import { onPath } from "../platform/on-path.js";
import { createGrokAgent, createGrokRunner } from "./grok-agent.js";
import { openCodeBinaryMissing, type OpenCodeService } from "./opencode.js";

/* EVERYTHING GROK CONTRIBUTES TO THE DAEMON, aggregated by the provider registry (agent/provider-module.ts is
 * the seam). The slice is one member because OpenCode is deliberately NOT Grok's: one warm `opencode serve`
 * also serves Gemini's native runtime and the delegation watchers, so the service stays core and this module
 * takes it as an input. */

export interface GrokSlice {
    readonly grokAgent: Services["agent"];
}

export const createGrokSlice = (openCode: OpenCodeService): GrokSlice => ({
    grokAgent: createGrokAgent(createGrokRunner(openCode)),
});

// Grok rides OpenCode with xAI subscription OAuth (OpenCode owns the credential). Gate on OpenCode's own
// connection view. Claude-only fields (plugins, MCP tools, thinking) don't apply.
export const planGrokTurn = async (services: Services, input: AgentTurn, context: TurnContext): Promise<TurnPlan> => {
    if (!(await services.openCode.connected("xai"))) {
        return {
            ok: false,
            message: "No Grok account connected, sign in with your xAI (SuperGrok/X Premium) account in Setup before chatting.",
        };
    }
    // Grok MUST ride an explicit, live-valid xAI model id: OpenCode's own default is a retired models.dev id
    // (grok-code-fast-1) xAI rejects, and its catalog is empty for xai, so an omitted model makes the turn fall
    // back to that same retired default. Resolve from the daemon's catalog (never empty, live discovery with a
    // persisted/seed floor): keep the pinned model when it's offered, else the default. If the resolved id turns
    // out stale, the runner self-heals it mid-turn from xAI's "Did you mean" rejection (grok-agent).
    const catalog = await services.openCode.xaiModels();
    const valid = new Set(catalog.models.map((entry) => entry.id));
    const model = input.model !== undefined && valid.has(input.model) ? input.model : catalog.default;
    return {
        ok: true,
        run: services.grokAgent,
        // OpenCode holds one xAI auth, so the single Grok account is "xai" (see grok.routes.ts).
        account: "xai",
        // Override base's input.model with the validated id; the adapter folds attachment paths into the prompt
        // (OpenCode's tools read them from disk).
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
        // Signed in, but OpenCode is a feature pack and this image may not carry it, a state the credential
        // cannot explain and only a rebuild fixes.
        return (await onPath("opencode")) ? healthReady() : healthUnavailable(openCodeBinaryMissing("Grok"));
    },
    holdsSession: (services, sessionId, cwd) => services.openCode.sessionExists(sessionId, cwd),
};

export const grokProvider: ProviderModule = {
    id: "grok",
    adapters: [OPENCODE_ADAPTER],
    catalog: (services) => services.openCode.xaiModels(),
    // The rung feeds the ROUTED pickers (Grok under the Claude Code harness), so it is the translator's
    // question, not OpenCode's: the native account is the adapter health's business above.
    ready: async (services, shared) => services.config.translator.url !== "" && (await shared.translatorAccounts()).grok.length > 0,
    /* Warm the OpenCode server at boot instead of lazily on the first sign-in. The cold `opencode serve` spawn
     * is CPU-heavy; in a constrained container it can deschedule the daemon long enough to stall the /events
     * heartbeat past the browser's watchdog, flashing the UI to "connecting" mid-session, which unmounts the
     * account page and aborts an in-flight connect. At boot that spike hides behind the initial connect screen.
     * Best-effort: ensure() is idempotent, so the first interactive call reuses this warm client.
     *
     * Warming is for a provider somebody USES, so it waits on the xAI credential OpenCode itself persists — a
     * sandbox that has never connected Grok was paying a ~175 MB bun spawn on every boot to hold a server for a
     * provider with no account behind it. And on a core image the binary is a pack away
     * (packs/opencode.Dockerfile), where the spawn only ever ends in the SDK's start timeout; the lazy path a
     * connect takes says so properly. */
    boot: (services, _role, logger) => {
        void (async () => {
            if (!(await services.openCode.connected("xai"))) {
                return;
            }
            if (!(await onPath("opencode"))) {
                logger.info("opencode: the binary is not in this image, add it by rebuilding from the Environment card");
                return;
            }
            await services.openCode.client();
        })().catch((error: unknown) => logger.warn({ err: error }, "opencode warmup failed, first grok connect boots it lazily"));
    },
    // OpenCode is the Grok credential store as well as its runtime: `connected` reads the auth.json a device
    // sign-in wrote, which is on disk whether or not a server is up (the provider-packs rule).
    packs: async (services) => ((await services.openCode.connected("xai")) ? ["opencode"] : []),
    // OpenCode holds one xAI auth per data dir, so Grok is a single fixed row rather than a list.
    secretEntries: async (services) =>
        (await services.openCode.connected("xai")) ? [providerAccountEntry("grok", "Grok", "xai", "Grok", authStateRelPath("opencode"))] : [],
};
