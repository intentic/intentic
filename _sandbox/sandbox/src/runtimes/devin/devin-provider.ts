import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { RoutedAgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import type { Logger } from "pino";
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
import { withAttachments } from "../../sessions/vocabulary/attachment-note.js";
import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../../agent/providers/provider-module.js";
import { releasingMounts } from "../../agent/tools/turn-mounts.js";
import { turnToolsOf, type TurnToolsDeps } from "../../agent/tools/turn-tools.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { assertAgentExecutionContext } from "../../workload/agent-execution.js";
import { turnPersona } from "../../personas/personas.js";
import type { AcpConnections } from "../acp/acp-connection.js";
import { type DaemonServersDeps, daemonServersFor } from "../daemon-tools/daemon-servers.js";
import { type DevinAccountDeps, devinAccountDoor } from "./accounts/devin-accounts.js";
import { type DevinStore, fileDevinStore, liveDevinAccounts, readDevinCredentials } from "./accounts/devin-credentials.js";
import { DEVIN_CLI_MISSING, devinAgentId, devinCli, devinLaunch } from "./devin-cli.js";
import { createDevinCatalog, DEVIN_OWN_PICK, type DevinCatalog } from "./models/devin-catalog.js";

// Everything Devin contributes to the daemon, listed in runtimes/runtime-table.ts. Devin's own CLI is the agent: the
// daemon signs an account in through it (accounts/), reads the account's models off the session it opens
// (models/), and serves turns over the ACP runtime with the account's key and the turn's model, one warm process per
// account. Beyond what an installed ACP agent gets, the account, its sign-in and its model are the daemon's to choose.

// The Services members Devin contributes; declared here so composition just spreads them.
export interface DevinSlice {
    // Devin accounts, several per sandbox; the sandbox owns each key, the CLI's own single-account file is never used.
    readonly devinStore: DevinStore;
    // The first account's models, as its sessions offer them.
    readonly devinModels: DevinCatalog;
}

export const createDevinSlice = (input: {
    readonly authRoot: string;
    readonly logger: Logger;
    readonly acpConnections: () => AcpConnections;
}): DevinSlice => {
    const devinStore = fileDevinStore(join(input.authRoot, "devin"), input.logger);
    return {
        devinStore,
        devinModels: createDevinCatalog({
            store: devinStore,
            connections: input.acpConnections,
            persistPath: join(input.authRoot, "devin", "models.json"),
            probeDir: join(tmpdir(), "intentic-devin-probe"),
        }),
    };
};

type DevinReadiness =
    { readonly ok: true; readonly binary: string } | { readonly ok: false; readonly detail: string; readonly code?: "subscription-required" };

// One answer to whether Devin can serve a turn, read by both the turn's refusal and the health probe's tooltip, in the
// order that names the right fix: no account (connect), every key refused (connect again), no CLI (rebuild).
const devinReadiness = async (store: DevinStore): Promise<DevinReadiness> => {
    const accounts = await store.credentials();
    if (accounts.length === 0) {
        return { ok: false, code: "subscription-required", detail: "Connect your Devin account in Sandbox ▸ Models to run Devin." };
    }
    if (!accounts.some((account) => account.refusedAt === undefined)) {
        return { ok: false, detail: "Devin no longer accepts this sandbox's sign-in. Connect your Devin account again in Sandbox ▸ Models." };
    }
    const binary = await devinCli();
    return binary === undefined ? { ok: false, detail: DEVIN_CLI_MISSING } : { ok: true, binary };
};

// A turn the CLI refused as signed out: the key is dead (revoked, or the account gone), so the row is marked for a new
// sign-in and the turn says where that is, rather than the installed-agent advice to run a login command.
async function* refusedSignIn(store: DevinStore, accountId: string, events: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent> {
    for await (const event of events) {
        if (event.kind === "error" && event.code === "acp-auth-required") {
            const stored = await store.read(accountId);
            if (stored !== undefined) {
                await store.write({ ...stored, refusedAt: Date.now() });
            }
            yield { kind: "error", message: "Devin no longer accepts this account's sign-in. Connect it again in Sandbox ▸ Models.", own: true };
            continue;
        }
        yield event;
    }
}

// What a Devin turn is planned from: the account store and catalog, the ACP runtime that serves it, and the seams its
// MCP tools and browser stack are mounted from.
export type DevinPlanDeps = TurnToolsDeps &
    DaemonServersDeps &
    Pick<Services, "acpAgent" | "capabilities" | "config" | "devinModels" | "devinStore" | "files" | "workspace" | "sandboxSettings">;

export const planDevinTurn = async (
    services: DevinPlanDeps,
    input: RoutedAgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Promise<TurnArmPlan> => {
    const readiness = await devinReadiness(services.devinStore);
    if (!readiness.ok) {
        return { ok: false, ...(readiness.code !== undefined ? { code: readiness.code } : {}), message: readiness.detail };
    }
    // A pinned account while it can still serve, else the first connected, the default where nothing else decides.
    const accounts = await liveDevinAccounts(services.devinStore);
    const account = input.account === undefined ? accounts[0] : accounts.find((entry) => entry.id === input.account);
    if (account === undefined) {
        return { ok: false, message: "That Devin account is no longer connected. Pick another one, or connect it again in Sandbox ▸ Models." };
    }
    // Keeps the pinned model while offered, else the account's own default; the floor is no choice at all.
    const catalog = await services.devinModels.models();
    const model = input.model !== undefined && catalog.models.some((entry) => entry.id === input.model) ? input.model : catalog.default;
    // The same remote MCP set the ACP floor mounts: a warm session keeps the MCP config it was opened with, so its turns
    // share the conversation's bearer.
    const mounted = await turnToolsOf(services, granted, {
        conversationId: input.conversationId,
        anonymousBrowser: context.persona?.powers.browser ?? true,
        shell: context.persona?.powers.shell ?? true,
        extensions: context.persona?.powers.extensions,
        warmSession: true,
    });
    // The daemon's own servers on the same lease, as the ACP floor mounts them (acp-adapter.ts).
    const persona = context.persona ?? turnPersona({ personas: [], actsAs: undefined, unattended: false });
    const settings = context.settings ?? (await services.sandboxSettings.get());
    const daemon = daemonServersFor(services, { input, context, persona, granted, settings, mounted, gate: false });
    const launch = devinLaunch(readiness.binary, account.apiKey);
    const options = model === DEVIN_OWN_PICK ? {} : { model };
    const tools = [...mounted.tools, ...daemon.tools];
    return armPlan(
        releasingMounts(
            (request) => refusedSignIn(services.devinStore, account.id, services.acpAgent(devinAgentId(account.id), launch, request, options)),
            mounted,
        ),
        withAttachments(
            {
                ...context.base,
                spec: { ...context.base.spec, model },
                tools: { ...context.base.tools, ...opt("remote", tools.length > 0 ? tools : undefined), diagnostics: daemon.diagnostics },
                hooks: { ...context.base.hooks, relay: daemon.relay },
                credential: { kind: "container" },
            },
            context.attachmentPaths,
        ),
        // The real account id, so usage and refusal frames name the connection that served.
        account.id,
    );
};

export type DevinAdapterDeps = DevinPlanDeps;

const DEVIN_ADAPTER: AgentAdapter<"devin", DevinAdapterDeps> = {
    runtime: "devin",
    preflight: (services, input, context, granted) => planDevinTurn(services, input, context, granted),
    health: async (services) => {
        const readiness = await attemptProbe(() => devinReadiness(services.devinStore));
        if (readiness === undefined) {
            return healthUnknown();
        }
        return readiness.ok ? healthReady() : healthUnavailable(readiness.detail);
    },
    // Always true, as on the ACP floor: a session lives in the CLI's own store, which the warm process is asked at
    // resume time (acp-agent.ts); answering "gone" here would retire every session blindly.
    holdsSession: async (_services, _sessionId, execution) => {
        assertAgentExecutionContext(execution);
        return true;
    },
};

// What the Devin module reads beyond its adapter: the account door's seams, and the auth root its pack wish is read from.
export type DevinProviderDeps = DevinAdapterDeps & DevinAccountDeps & Pick<Services, "authRoot">;

export const devinProvider: ProviderModule<DevinProviderDeps> = {
    id: "devin",
    accounts: devinAccountDoor,
    adapters: [DEVIN_ADAPTER],
    catalog: (services) => services.devinModels.models(),
    // A key the CLI has not refused; the CLI's presence is the health probe's question, which names the rebuild.
    ready: async (services) => (await liveDevinAccounts(services.devinStore)).length > 0,
    engines: ["devin"],
    // Devin's CLI can't ship in a published image (no redistribution grant): Connect installs it into the engine store,
    // and an account on disk asks the owner's next rebuild to bake it. Reads the file-backed store, never a live probe.
    packs: async (services) => ((await readDevinCredentials(join(services.authRoot, "devin"))).length > 0 ? ["devin"] : []),
    secretEntries: async (services) =>
        (await services.devinStore.list()).map((account) =>
            providerAccountEntry("devin", "Devin", account.id, account.label, authStateRelPath("devin", `${account.id}.json`)),
        ),
};
