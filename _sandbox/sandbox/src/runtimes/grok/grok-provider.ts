import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import {
    attemptProbe,
    armPlan,
    type AgentAdapter,
    healthReady,
    healthUnavailable,
    healthUnknown,
    privacyTurnRefusal,
    type TurnArmPlan,
    type TurnContext,
} from "../../agent/providers/adapter.js";
import type { AgentRequest, OpenCodeCredential } from "../../agent/providers/agent-request.js";
import { withAttachments } from "../../sessions/vocabulary/attachment-note.js";
import { releasingMounts } from "../../agent/tools/turn-mounts.js";
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
import { type OpenCodeHostedDeps, openCodeRouteHealth, planOpenCodeRouteTurn } from "../opencode/hosted/opencode-hosted.js";
import { doorToolsOf, type DoorToolsDeps } from "../daemon-tools/door-tools.js";
import { sharedServerRefusal } from "../../privacy/harness-route.js";
import { opt } from "../../opt.js";
import { requireRootAgentExecution } from "../../workload/agent-execution.js";
import { GROK_BUILD } from "../grok-build/grok-build-cli.js";
import { grokDoors } from "../grok-build/grok-build-door.js";
import { type CliDoorDeps, cliAccountDoor } from "../vendor-cli/vendor-cli-door.js";
import { type CliParts, cliPacks, cliReady, cliSecretEntries } from "../vendor-cli/vendor-cli-slice.js";
import { cliAdapter, type CliTurnDeps } from "../vendor-cli/vendor-cli-turn.js";

// Everything Grok contributes, listed in runtimes/runtime-table.ts. Its default loop and credential are OpenCode's
// (runtimes/opencode); its `vendor` loop is xAI's own Grok Build CLI with a sign-in of its own (runtimes/grok-build).

export interface GrokSlice {
    // The shared OpenCode loop: Grok's turns on OpenCode's own xAI entry, and every hosted route's on the entry its
    // credential names (opencode-hosted.ts).
    readonly grokAgent: (request: AgentRequest<OpenCodeCredential>) => AsyncGenerator<AgentEvent>;
    // Grok Build's accounts and the models the first one offers, for the `vendor` loop (runtimes/grok-build).
    readonly grokBuild: CliParts;
}

// Grok rides OpenCode with xAI subscription OAuth; gated on OpenCode's own connection view. The turn's remote MCP servers
// and the daemon's own servers ride along over the MCP door (daemon-tools/door-tools.ts), with no gate server, since
// OpenCode asks the daemon over its own permission channel; Claude-only fields (plugins, thinking) don't apply. What a
// Grok turn is planned from, and all its adapter reads: OpenCode holds the credential, the catalog and sessions, and the
// turn's mounts are leased from the daemon's MCP door.
export type GrokAdapterDeps = DoorToolsDeps & Pick<Services, "grokAgent" | "openCode" | "privacyShield">;

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
    const refused = await sharedServerRefusal(services.privacyShield, services.openCode.shielded, "grok", input.conversationId);
    if (refused !== undefined) {
        return privacyTurnRefusal(refused);
    }
    // OpenCode's own default is a retired id xAI rejects, so this resolves from the daemon's catalog instead (never
    // empty): keeps the pinned model if valid, else the catalog default. A stale id self-heals mid-turn via xAI's "Did
    // you mean" rejection.
    const catalog = await services.openCode.xaiModels();
    const valid = new Set(catalog.models.map((entry) => entry.id));
    const model = input.model !== undefined && valid.has(input.model) ? input.model : catalog.default;
    // Leased last, once nothing can refuse the turn: only the loop it arms releases it.
    const { mounted, tools, hooks } = await doorToolsOf(services, input, context, granted, false);
    // Overrides base's input.model with the validated id; the adapter folds attachment paths into the prompt. OpenCode
    // holds one xAI auth, so the single Grok account is OpenCode's xAI provider id (see grok-accounts.ts).
    return armPlan(
        releasingMounts(services.grokAgent, mounted),
        withAttachments(
            {
                ...context.base,
                // The turn's steering queue, which the OpenCode loop sends on as steers (capabilities.steering).
                spec: { ...context.base.spec, model, ...opt("steering", context.steering) },
                tools,
                hooks,
                credential: { kind: "container" },
            },
            context.attachmentPaths,
        ),
        OPENCODE_XAI_PROVIDER,
    );
};

// One adapter for the OpenCode runtime: Grok on OpenCode's own xAI sign-in, and every other provider OpenCode hosts on
// its route. Health keys off the runtime, so the runtime's own answer is Grok's and each hosted provider has its own.
const OPENCODE_ADAPTER: AgentAdapter<"opencode", GrokAdapterDeps & OpenCodeHostedDeps> = {
    runtime: "opencode",
    preflight: (services, input, context, granted) =>
        input.agent === "grok" ? planGrokTurn(services, input, context, granted) : planOpenCodeRouteTurn(services, input, context, granted),
    hostHealth: (services, provider) => (provider === "grok" ? OPENCODE_ADAPTER.health(services) : openCodeRouteHealth(services, provider)),
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

export type GrokBuildAdapterDeps = CliTurnDeps & Pick<Services, "grokBuild">;

const GROK_BUILD_ADAPTER = cliAdapter<"grok-build", GrokBuildAdapterDeps>({ ...GROK_BUILD, runtime: "grok-build" }, (services) => services.grokBuild);

// What the Grok module reads beyond its adapters: the translator's answer for the routed pickers, what the hosted routes
// on its OpenCode runtime are planned from, and both sign-in doors' seams.
export type GrokProviderDeps = GrokAdapterDeps & OpenCodeHostedDeps & GrokBuildAdapterDeps & GrokAccountDeps & CliDoorDeps & Pick<Services, "config">;

export const grokProvider: ProviderModule<GrokProviderDeps> = {
    id: "grok",
    // OpenCode's alone: the OpenCode loop's health reads it, and Grok Build's adapter checks its own engine.
    engines: ["opencode"],
    accounts: (services) =>
        grokDoors(
            grokAccountDoor(services),
            cliAccountDoor(GROK_BUILD, services.grokBuild.store, services.grokBuild.models, services),
            async (id) => (await services.grokBuild.store.read(id)) !== undefined,
        ),
    adapters: [OPENCODE_ADAPTER, GROK_BUILD_ADAPTER],
    catalog: (services) => services.openCode.xaiModels(),
    // Feeds the routed pickers (Grok under the Claude Code harness); the translator's question, not OpenCode's (native
    // account health is above).
    ready: async (services, shared) => (await translatorReady("grok")(services, shared)) || (await cliReady(services.grokBuild)),
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
    packs: async (services) => [
        ...((await services.openCode.connected(OPENCODE_XAI_PROVIDER)) ? ["opencode"] : []),
        ...(await cliPacks(GROK_BUILD, services.authRoot)),
    ],
    // OpenCode holds one xAI auth per data dir, so Grok is a single fixed row rather than a list.
    secretEntries: async (services) => [
        ...((await services.openCode.connected(OPENCODE_XAI_PROVIDER))
            ? [providerAccountEntry("grok", "Grok", OPENCODE_XAI_PROVIDER, "Grok", authStateRelPath("opencode"))]
            : []),
        ...(await cliSecretEntries(GROK_BUILD, services.grokBuild)),
    ],
};
