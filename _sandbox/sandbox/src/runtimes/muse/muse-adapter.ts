import { errorMessage } from "@intentic/base/errors";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { endpointIdOf, isTrialProvider } from "@intentic/sandbox-contract/models/agent-catalog";
import type { RoutedAgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import {
    type AgentAdapter,
    armPlan,
    attemptProbe,
    healthReady,
    healthUnavailable,
    healthUnknown,
    type TurnArmPlan,
    type TurnContext,
} from "../../agent/providers/adapter.js";
import type { MuseCredential } from "../../agent/providers/agent-request.js";
import { routedModel } from "../../agent/providers/harness-credentials.js";
import { withAttachments } from "../../sessions/vocabulary/attachment-note.js";
import { releasingMounts } from "../../agent/tools/turn-mounts.js";
import { turnToolsOf, type TurnToolsDeps } from "../../agent/tools/turn-tools.js";
import type { Services } from "../../composition.js";
import { endpointModelId } from "../../endpoints/endpoint-translator.js";
import { endpointConfigOf } from "../../endpoints/local-model.js";
import { opt } from "../../opt.js";
import { turnPersona } from "../../personas/personas.js";
import { assertAgentExecutionContext } from "../../workload/agent-execution.js";
import { daemonServersFor, type DaemonServersDeps } from "../daemon-tools/daemon-servers.js";
import { createMuseAgent } from "./muse-agent.js";
import { ensureMuseCli, MUSE_CLI_MISSING, museCli } from "./muse-cli.js";

// Muse Code as a runtime any provider can be served on (agent-catalog.ts `providerLoops`): Meta's own loop for a key
// minted from a Muse Code sign-in, and a host for an `endpoint/<id>` the user configured, reached through the daemon's
// translator on the Responses wire Muse's provider speaks. A plain adapter beside the runtime it serves, like ACP's: the
// accounts, catalogs and packs belong to the providers it serves (runtimes/minted for Meta, the capability system for an
// endpoint).

// The loop every Muse turn runs; one per daemon, since a turn's host lives and dies inside the turn.
const runMuseAgent = createMuseAgent();

// What the Muse adapter reads: Meta's minted accounts, the endpoint capabilities and their catalogs, the translator,
// and the seams the turn's MCP servers and the daemon's own tools are mounted from.
export type MuseAdapterDeps = TurnToolsDeps &
    DaemonServersDeps &
    Pick<Services, "capabilities" | "config" | "endpointModels" | "minted" | "sandboxSettings" | "wakeLocalModel" | "workspace">;

type MuseCredentialPlan = { readonly ok: true; readonly credential: MuseCredential; readonly model?: string; readonly account?: string } | Extract<TurnArmPlan, { ok: false }>;

const META_REQUIRED = "Connect your Muse Code subscription in Sandbox ▸ Agent to run Muse Code.";

// Meta's key, as its sign-in minted it: the account the conversation runs on, else the first connected. A named account
// that is gone refuses: running on another one instead is a switch nobody chose.
const metaCredential = async (services: Pick<Services, "minted">, input: RoutedAgentTurn): Promise<MuseCredentialPlan> => {
    const accounts = await services.minted.meta.store.credentials();
    const picked = input.account === undefined ? accounts[0] : accounts.find((account) => account.id === input.account);
    if (picked === undefined) {
        return input.account === undefined
            ? { ok: false, code: "subscription-required", message: META_REQUIRED }
            : { ok: false, message: "The Meta account this conversation runs on is no longer connected. Pick another account for it, or connect this one again, then send again." };
    }
    // The minted catalog is the picker's; the turn's own host checks the pick against Muse's model/list (muse-agent.ts).
    const catalog = await services.minted.meta.catalogOf(picked.variant).models();
    return { ok: true, credential: { kind: "muse", apiKey: picked.apiKey }, model: routedModel(catalog, input.model), account: picked.id };
};

// An endpoint the user configured, served through the translator: it already speaks OpenAI's Responses wire for every
// OpenAI-protocol endpoint it carries (endpoint-translator.ts), which is the wire Muse's provider talks. An
// Anthropic-protocol endpoint is not on the translator, and Muse cannot speak Messages.
const endpointCredential = async (
    services: Pick<Services, "capabilities" | "config" | "endpointModels" | "wakeLocalModel">,
    id: string,
    input: RoutedAgentTurn,
): Promise<MuseCredentialPlan> => {
    if (isTrialProvider(input.agent)) {
        return { ok: false, message: "The free trial runs under Claude Code only. Pick Claude Code for it, or connect your own model." };
    }
    const capability = await services.capabilities.get(id);
    const config = capability === undefined ? undefined : endpointConfigOf(capability);
    if (capability === undefined || config === undefined) {
        return { ok: false, message: `Unknown model endpoint "${id}", add it as an Endpoint capability first.` };
    }
    if (config.protocol !== "openai") {
        return {
            ok: false,
            message: `${id} speaks Anthropic's Messages API, and Muse Code speaks OpenAI's Responses API. Run ${id} under Claude Code instead.`,
        };
    }
    if (services.config.translator.url === "") {
        return { ok: false, message: "This sandbox has no model translator, so Muse Code can't reach an endpoint here. Run a sandbox built from the published image." };
    }
    if (capability.kind === "localmodel") {
        await services.wakeLocalModel(id);
    }
    const catalog = await services.endpointModels.models(id, config);
    if (catalog.models.length === 0) {
        return { ok: false, message: `${id} has published no models, check the server is running at ${config.baseUrl} and has a model loaded.` };
    }
    const model = routedModel(catalog, input.model);
    const row = catalog.models.find((entry) => entry.id === model);
    return {
        ok: true,
        model,
        credential: {
            kind: "muse",
            // The translator's own bearer: the endpoint's key stays in the translator's config, never in Muse's env.
            apiKey: services.config.translator.token,
            endpoint: {
                baseUrl: `${services.config.translator.url.replace(/\/$/, "")}/v1`,
                model: endpointModelId(id, model),
                ...opt("label", row?.label),
                ...opt("contextLimit", row?.contextWindow),
            },
        },
    };
};

const credentialOf = async (services: MuseAdapterDeps, input: RoutedAgentTurn): Promise<MuseCredentialPlan> => {
    const endpoint = endpointIdOf(input.agent);
    if (endpoint !== undefined) {
        return endpointCredential(services, endpoint, input);
    }
    if (input.agent === "meta") {
        return metaCredential(services, input);
    }
    return { ok: false, message: `${input.agent} does not run on Muse Code.` };
};

export const planMuseTurn = async (services: MuseAdapterDeps, input: RoutedAgentTurn, context: TurnContext, granted: readonly Capability[]): Promise<TurnArmPlan> => {
    const credential = await credentialOf(services, input);
    if (!credential.ok) {
        return credential;
    }
    // The program comes down on first use: no published image may carry it (image-packs/muse.Dockerfile).
    try {
        await ensureMuseCli();
    } catch (error) {
        return { ok: false, message: `${MUSE_CLI_MISSING} (${errorMessage(error)})` };
    }
    const persona = context.persona ?? turnPersona({ personas: [], actsAs: undefined, unattended: false });
    const mounted = await turnToolsOf(services, granted, {
        conversationId: input.conversationId,
        anonymousBrowser: persona.powers.browser,
        shell: persona.powers.shell,
        extensions: persona.powers.extensions,
    });
    const settings = context.settings ?? (await services.sandboxSettings.get());
    // Muse asks about commands over its own approval channel, answered in-process (muse-asks.ts), so no gate server.
    const daemon = daemonServersFor(services, { input, context, persona, granted, settings, mounted, gate: false });
    const remote = [...mounted.tools, ...daemon.tools];
    return armPlan(
        releasingMounts(runMuseAgent, mounted),
        withAttachments(
            {
                ...context.base,
                spec: { ...context.base.spec, ...opt("model", credential.model), ...opt("steering", context.steering) },
                tools: { ...context.base.tools, ...opt("remote", remote.length > 0 ? remote : undefined), diagnostics: daemon.diagnostics },
                hooks: { ...context.base.hooks, relay: daemon.relay },
                credential: credential.credential,
            },
            context.attachmentPaths,
        ),
        // The real account id for Meta, so usage and refusal frames name the connection that served; none for an endpoint.
        credential.account,
    );
};

// One answer to whether Muse can serve a turn, in the order that names the right fix: nothing to run it on (connect),
// then the program itself (it installs on first use, or the rebuild bakes it).
type MuseReadiness = { readonly ok: true } | { readonly ok: false; readonly detail: string };

const museReadiness = async (services: Pick<Services, "capabilities" | "minted">): Promise<MuseReadiness> => {
    const [accounts, capabilities] = await Promise.all([services.minted.meta.store.list(), services.capabilities.list()]);
    const endpoints = capabilities.some((capability) => endpointConfigOf(capability)?.protocol === "openai");
    if (accounts.length === 0 && !endpoints) {
        return { ok: false, detail: META_REQUIRED };
    }
    return (await museCli()) === undefined ? { ok: false, detail: MUSE_CLI_MISSING } : { ok: true };
};

export const MUSE_ADAPTER: AgentAdapter<"muse", MuseAdapterDeps> = {
    runtime: "muse",
    preflight: (services, input, context, granted) => planMuseTurn(services, input, context, granted),
    health: async (services) => {
        const readiness = await attemptProbe(() => museReadiness(services));
        if (readiness === undefined) {
            return healthUnknown();
        }
        return readiness.ok ? healthReady() : healthUnavailable(readiness.detail);
    },
    // Always true, as Devin's and the ACP floor's are: a session lives in Muse's own store, which the turn's host is asked
    // at resume time; one it no longer holds opens fresh there (muse-agent.ts `openSession`).
    holdsSession: async (_services, _sessionId, execution) => {
        assertAgentExecutionContext(execution);
        return true;
    },
};
