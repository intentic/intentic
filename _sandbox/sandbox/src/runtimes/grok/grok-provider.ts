import type { AgentEvent, AgentTurn, Capability } from "@intentic/sandbox-contract";
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
    authStateRelPath,
    engineMissing,
    enginesReady,
    type ProviderModule,
    providerAccountEntry,
    translatorReady,
} from "../../agent/providers/provider-module.js";
import type { Services } from "../../composition.js";
import { type GrokAccountDeps, grokAccountDoor } from "./grok-accounts.js";
import { OPENCODE_XAI_PROVIDER } from "../opencode/xai-models.js";
import { sharedServerRefusal } from "../../privacy/harness-route.js";
import { requireRootAgentExecution } from "../../workload/agent-execution.js";

// Everything Grok contributes, listed in runtimes/runtime-table.ts; its loop and credential are OpenCode's (runtimes/opencode).

export interface GrokSlice {
    readonly grokAgent: (request: AgentRequest<ContainerCredential>) => AsyncGenerator<AgentEvent>;
}

// Grok rides OpenCode with xAI subscription OAuth; gated on OpenCode's own connection view. The turn's remote MCP servers
// ride along as Codex's do; Claude-only fields (plugins, the daemon's in-process servers, thinking) don't apply.
// What a Grok turn is planned from, and all its adapter reads: OpenCode holds the credential, the catalog and sessions,
// and the turn's mounts are leased from the daemon's MCP door.
export type GrokAdapterDeps = TurnToolsDeps & Pick<Services, "grokAgent" | "openCode" | "privacyShield">;

export const planGrokTurn = async (
    services: GrokAdapterDeps,
    input: AgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Promise<TurnArmPlan> => {
    if (!(await services.openCode.connected(OPENCODE_XAI_PROVIDER))) {
        return {
            ok: false,
            message: "No Grok account connected, sign in with your xAI (SuperGrok/X Premium) account in Setup before chatting.",
        };
    }
    const refused = await sharedServerRefusal(services.privacyShield, services.openCode.shielded, "grok").catch((error: unknown) =>
        error instanceof Error ? error.message : "the privacy shield's policy could not be read",
    );
    if (refused !== undefined) {
        return { ok: false, message: refused };
    }
    // OpenCode's own default is a retired id xAI rejects, so this resolves from the daemon's catalog instead (never
    // empty): keeps the pinned model if valid, else the catalog default. A stale id self-heals mid-turn via xAI's "Did
    // you mean" rejection.
    const catalog = await services.openCode.xaiModels();
    const valid = new Set(catalog.models.map((entry) => entry.id));
    const model = input.model !== undefined && valid.has(input.model) ? input.model : catalog.default;
    // Leased last, once nothing can refuse the turn: only the loop it arms releases it.
    const mounted = await turnToolsOf(services, granted, {
        conversationId: input.conversationId,
        anonymousBrowser: context.persona?.powers.browser ?? true,
        shell: context.persona?.powers.shell ?? true,
        extensions: context.persona?.powers.extensions,
    });
    // Overrides base's input.model with the validated id; the adapter folds attachment paths into the prompt. OpenCode
    // holds one xAI auth, so the single Grok account is OpenCode's xAI provider id (see grok-accounts.ts).
    return armPlan(
        releasingMounts(services.grokAgent, mounted),
        withAttachments(
            {
                ...context.base,
                spec: { ...context.base.spec, model },
                tools: mounted.tools.length > 0 ? { ...context.base.tools, remote: mounted.tools } : context.base.tools,
                credential: { kind: "container" },
            },
            context.attachmentPaths,
        ),
        OPENCODE_XAI_PROVIDER,
    );
};

const OPENCODE_ADAPTER: AgentAdapter<"opencode", GrokAdapterDeps> = {
    runtime: "opencode",
    preflight: (services, input, context, granted) => planGrokTurn(services, input, context, granted),
    health: async (services) => {
        const connected = await attemptProbe(() => services.openCode.connected(OPENCODE_XAI_PROVIDER));
        if (connected === undefined) {
            return healthUnknown();
        }
        if (!connected) {
            return healthUnavailable("Sign in with your xAI (SuperGrok/X Premium) account in Setup.");
        }
        // Signed in, but OpenCode is a feature pack this image may not carry; only a rebuild or an Environment-card
        // install fixes it.
        return (await enginesReady(grokProvider)) ? healthReady() : healthUnavailable(engineMissing("the OpenCode CLI", "Grok"));
    },
    holdsSession: async (services, sessionId, execution) => {
        requireRootAgentExecution(execution, "Grok's shared OpenCode session probe");
        return services.openCode.sessionExists(sessionId, execution.cwd);
    },
};

// What the Grok module reads beyond its adapter: the translator's answer for the routed pickers.
export type GrokProviderDeps = GrokAdapterDeps & GrokAccountDeps & Pick<Services, "config">;

export const grokProvider: ProviderModule<GrokProviderDeps> = {
    id: "grok",
    engines: ["opencode"],
    accounts: grokAccountDoor,
    adapters: [OPENCODE_ADAPTER],
    catalog: (services) => services.openCode.xaiModels(),
    // Feeds the routed pickers (Grok under the Claude Code harness); the translator's question, not OpenCode's (native
    // account health is above).
    ready: translatorReady("grok"),
    // Warms the OpenCode server at boot: a cold spawn can stall the /events heartbeat past the browser's watchdog. Runs
    // only if xAI is already connected; ensure() is idempotent, so the first interactive call reuses this client.
    boot: (services, _role, logger) => {
        void (async () => {
            if (!(await services.openCode.connected(OPENCODE_XAI_PROVIDER))) {
                return;
            }
            if (!(await enginesReady(grokProvider))) {
                logger.info("opencode: the binary is not in this image, add it by rebuilding from the Environment card");
                return;
            }
            await services.openCode.client();
        })().catch((error: unknown) => logger.warn({ err: error }, "opencode warmup failed, first grok connect boots it lazily"));
    },
    // OpenCode is Grok's credential store too: `connected` reads the credential a device sign-in stored, on disk whether
    // or not a server is up.
    packs: async (services) => ((await services.openCode.connected(OPENCODE_XAI_PROVIDER)) ? ["opencode"] : []),
    // OpenCode holds one xAI auth per data dir, so Grok is a single fixed row rather than a list.
    secretEntries: async (services) =>
        (await services.openCode.connected(OPENCODE_XAI_PROVIDER))
            ? [providerAccountEntry("grok", "Grok", OPENCODE_XAI_PROVIDER, "Grok", authStateRelPath("opencode"))]
            : [],
};
