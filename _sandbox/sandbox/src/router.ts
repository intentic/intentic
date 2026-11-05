import type { Router } from "@orpc/server";
import type { sandboxContract } from "@intentic/sandbox-contract";
import type { OrpcContext } from "./app-env.js";
import { createActivityRoutes } from "./activity/activity.routes.js";
import { createAuditRoutes } from "./audit/audit.routes.js";
import { createAgentRoutes } from "./agent/routes/agent.routes.js";
import { createProvidersRoutes } from "./agent/routes/providers.routes.js";
import { createAgentsRoutes } from "./conversations/agents.routes.js";
import { createAttentionRoutes } from "./conversations/attention.routes.js";
import { createHomeFreshRoutes } from "./conversations/home/home-fresh.routes.js";
import { portJobOf, runningJobsOf } from "./agent/tools/jobs/background-jobs.js";
import { portOwnerOf } from "./agent/tools/jobs/port-owners.js";
import { reattributeHandedPorts } from "./agent/tools/jobs/handed-ports.js";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { createTranslatorRoutes } from "./agent/routes/translator.routes.js";
import { createAutomationsRoutes } from "./automations/automations.routes.js";
import { probeDockerGpu } from "./hosts/docker-gpu-probe.js";
import { createCapabilitiesRoutes } from "./capabilities/capabilities.routes.js";
import { createPersonasRoutes } from "./personas/personas.routes.js";
import { createOrgRoutes } from "./org/org.routes.js";
import { createChoresRoutes } from "./chores/chores.routes.js";
import { createCiRoutes } from "./ci/ci.routes.js";
import { createComplianceRoutes } from "./compliance/compliance.routes.js";
import { createDiffRoutes } from "./git/changes/diff-derived.js";
import type { Services } from "./composition.js";
import { join } from "node:path";
import { createApprovalsRoutes } from "./approvals/approvals.routes.js";
import { createExtensionsRoutes } from "./extensions/extensions.routes.js";
import { createEndpointsRoutes } from "./endpoints/endpoints.routes.js";
import { createGitRoutes } from "./git/git.routes.js";
import { createDeviceSystemRoutes } from "./hosts/devices.routes.js";
import { createAccountsRoutes } from "./agent/routes/accounts.routes.js";
import { createSharingRoutes } from "./links/sharing.routes.js";
import { createHistoryRoutes } from "./history/history.routes.js";
import { createIntenticRoutes } from "./intentic/intentic.routes.js";
import { createInventoryRoutes } from "./inventory/inventory.routes.js";
import { createIssuesRoutes } from "./issues/issues.routes.js";
import { createLogsRoutes } from "./logs/logs.routes.js";
import { createLoopsRoutes } from "./loops/loops.routes.js";
import { createWorkflowsRoutes } from "./workflows/workflows.routes.js";
import { createPanelsRoutes } from "./panels/panels.routes.js";
import { createRunsRoutes } from "./hosts/runs/runs.routes.js";
import { createPortsRoutes } from "./ports/ports.routes.js";
import { createPublicRoutes } from "./public/public.routes.js";
import { createPagesRoutes } from "./agent/pages/pages.routes.js";
import { createNetdiskRoutes } from "./netdisk/netdisk.routes.js";
import { createPushRoutes } from "./push/push.routes.js";
import { createSecretsRoutes } from "./secrets/secrets.routes.js";
import { createNeedsRoutes } from "./needs/needs.routes.js";
import { unapproveExtension } from "./extensions/extension-removal.js";
import { ownerApprovals } from "./needs/standing-grants.js";
import { provenanceOf, visibleTo } from "./auth/fleet-scope.js";
import { providerSecretEntries } from "./agent/providers/provider-registry.js";
import { createSessionsRoutes } from "./sessions/sessions.routes.js";
import { createPrivacyRoutes } from "./privacy/privacy.routes.js";
import { createSafetyRoutes } from "./safety/safety.routes.js";
import { createSettingsRoutes } from "./settings/settings.routes.js";
import { createSealRoutes } from "./conversations/seal/seal.routes.js";
import { placePeopleShells } from "./agent/run/placement/jail-placement.js";
import { createShareRoutes } from "./share/share.routes.js";
import { createSkillsRoutes } from "./settings/skills.routes.js";
import { createAreasRoutes } from "./areas/areas.routes.js";
import { createStorageRoutes } from "./system/resources/storage/storage.routes.js";
import { type BuildOutputReaper, createBuildOutputReaper } from "./conversations/registry/build-output-sweep/build-output-reaper.js";
import { CheckoutBusy, releaseCheckout } from "./conversations/registry/archive.js";
import { checkoutStanding } from "./conversations/registry/checkout-standing.js";
import { LeftoverRefused, trashLeftover } from "./conversations/worktrees/orphan-checkouts.js";
import { type CheckoutActions, CheckoutActionRefused } from "./system/resources/storage/checkout-usage.js";
import { isBuildOutputPath } from "./conversations/worktrees/build-outputs/build-outputs.js";
import { isWarmLayer } from "./conversations/worktrees/cargo-warm.js";
import { overlaysRoot } from "./conversations/worktrees/isolation.js";
import { createSystemRoutes } from "./system/system.routes.js";
import { createUsageRoutes } from "./usage/usage.routes.js";
import { createExitRoutes } from "./exit/exit.routes.js";
import { createVpnRoutes } from "./vpn/vpn.routes.js";
import { createOffloadRoutes } from "./offload/offload.routes.js";
import { createAccessProfilesRoutes } from "./access/access-profiles.routes.js";
import { createServicesRoutes } from "./access/services.routes.js";
import { createAgentContinueRoutes } from "./agent/routes/agent-continue.routes.js";
import { createAgentQueueRoutes } from "./agent/routes/agent-queue.routes.js";
import { createWorkspaceRoutes } from "./workspace/workspace.routes.js";
import { createWorkspaceTicketRoutes } from "./workspace/workspace-tickets.routes.js";
import { createWorkspaceFollowRoutes } from "./workspace/workspace-follow.routes.js";
import { createWorkspaceMediaRoutes } from "./workspace/workspace-media.routes.js";
import { createWorkspaceSearchRoutes } from "./workspace/workspace-search.routes.js";
import { pruneStore } from "./workspace/watch/state-janitor.js";

// The implemented oRPC router, the per-domain route factories assembled into the sandboxContract shape. The
// OpenAPIHandler in app.ts serves it. Typed by the contract it implements rather than inferred: the inferred type
// outgrew what the compiler will write into a declaration file (TS7056), and naming the contract also checks here that
// every procedure it declares is served.
export type SandboxRouter = Router<typeof sandboxContract, OrpcContext>;


// The Storage card's presses run over a reaper of their own (a press ignores what earlier passes remember anyway).
const storageReaper = (services: Services): BuildOutputReaper =>
    createBuildOutputReaper({
        archive: services,
        worktreesRoot: join(services.config.historyRoot, "worktrees"),
        overlaysRoot: overlaysRoot(services.config.historyRoot),
        runningJobs: (id) => runningJobsOf(services.conversations, id).length,
    });

// What the Storage card needs of build output in checkouts: how its scan recognises a folder as one, whether a clean may
// take it now, and the clean itself.
const storageBuildOutputs = (reaper: BuildOutputReaper) => ({
    // A shared Cargo target's overlay layer is build output too (cargo-warm.ts): what one checkout compiled differently.
    detect: async (dir: string) => (await isBuildOutputPath(dir)) || (await isWarmLayer(dir)),
    reapable: (path: string) => reaper.reapable(path, Date.now()),
    reap: async () => {
        const swept = await reaper.reapAll(Date.now());
        return { removed: swept.reduce((total, one) => total + one.removed.length, 0), failed: 0 };
    },
});

// The Storage card's per-conversation rows and presses (system/resources/storage/checkout-usage.ts). A refusal from the
// conversation's state, on either side of the subsystem line, becomes the route's conflict.
const storageCheckouts = (services: Services, reaper: BuildOutputReaper): CheckoutActions => {
    const runningJobs = (id: string) => runningJobsOf(services.conversations, id).length;
    const leftovers = {
        historyRoot: services.config.historyRoot,
        worktreesRoot: join(services.config.historyRoot, "worktrees"),
        registry: services.agents,
        owners: services.conversationUnits.owners,
        logger: services.logger,
    };
    const refused = async <T>(press: () => Promise<T>): Promise<T> => {
        try {
            return await press();
        } catch (error) {
            throw error instanceof CheckoutBusy || error instanceof LeftoverRefused ? new CheckoutActionRefused(error.message) : error;
        }
    };
    return {
        factsOf: (id) => checkoutStanding({ archive: services, runningJobs, leftovers }, id),
        clean: (id) => refused(async () => ({ id, removed: [...(await reaper.reapOne(id)).removed] })),
        release: (id) => refused(() => releaseCheckout(services, runningJobs, id)),
        trash: (id) => refused(() => trashLeftover(leftovers, id)),
    };
};

// One reaper for both, made once per router.
const storageRoutes = (services: Services) => {
    const reaper = storageReaper(services);
    return createStorageRoutes(services, (storeDir) => pruneStore(storeDir, services.logger), storageBuildOutputs(reaper), storageCheckouts(services, reaper));
};

export const createRouter = (services: Services): SandboxRouter => ({
    accessProfiles: createAccessProfilesRoutes(services),
    accounts: createAccountsRoutes(services),
    activity: createActivityRoutes(services),
    audit: createAuditRoutes(services),
    agent: { ...createAgentRoutes(services), ...createAgentContinueRoutes(services), ...createAgentQueueRoutes(services) },
    agents: { ...createAgentsRoutes(services), ...createAttentionRoutes(services), ...createHomeFreshRoutes(services) },
    automations: createAutomationsRoutes(services),
    capabilities: createCapabilitiesRoutes(services, probeDockerGpu),
    chores: createChoresRoutes(services),
    ci: createCiRoutes(services),
    compliance: createComplianceRoutes(services),
    diff: createDiffRoutes(services),
    approvals: createApprovalsRoutes(services),
    extensions: createExtensionsRoutes(services),
    personas: createPersonasRoutes(services),
    services: createServicesRoutes(services),
    org: createOrgRoutes(services),
    privacy: createPrivacyRoutes(services),
    safety: createSafetyRoutes(services),
    sessions: createSessionsRoutes(services),
    settings: createSettingsRoutes(services),
    // People's shells follow a change to who reads what at once (agent/run/placement/jail-placement.ts).
    seal: createSealRoutes(services, () => {
        void placePeopleShells(services).catch((error) => services.logger.warn({ err: error }, "seal: people's shells could not be placed"));
    }),
    share: createShareRoutes(services),
    // Model accounts brought in from, or lent to, another of the owner's sandboxes (links/accounts/).
    sharing: createSharingRoutes(services),
    skills: createSkillsRoutes(services),
    areas: createAreasRoutes(services),
    intentic: createIntenticRoutes(services),
    endpoints: createEndpointsRoutes(services),
    git: createGitRoutes(services),
    history: createHistoryRoutes(services),
    workspace: {
        ...createWorkspaceRoutes(services),
        ...createWorkspaceSearchRoutes(services),
        ...createWorkspaceTicketRoutes(services),
        ...createWorkspaceMediaRoutes(services),
        ...createWorkspaceFollowRoutes(services),
    },
    inventory: createInventoryRoutes(services),
    issues: createIssuesRoutes(services),
    logs: createLogsRoutes(services),
    loops: createLoopsRoutes(services),
    workflows: createWorkflowsRoutes(services),
    // What an MCP server's app drawn in a chat asks of its own server (agent/pages/mcp-apps.ts).
    pages: createPagesRoutes(services),
    panels: createPanelsRoutes(services),
    // A server an agent left running for the person is named on its port's row by its job.
    // Every other agent's port by its conversation, from its jobs or its shell's tmux session (agent/tools/jobs/port-owners.ts).
    ports: createPortsRoutes({
        ...services,
        jobOn: (port) => portJobOf(services.conversations, port),
        nameHandedPorts: (listeners) => reattributeHandedPorts({ conversations: services.conversations, logger: services.logger }, listeners),
        ownerOn: (listener) =>
            portOwnerOf(services.conversations, listener, (session) =>
                services.agents.ids().find((id) => {
                    const sessionId = services.conversations.sessionIdOf(id);
                    return sessionId !== undefined && agentSessionName(sessionId) === session;
                }),
            ),
    }),
    // A repository's programs run on the owner's own computers: its declared targets, and the button that runs one.
    runs: createRunsRoutes(services),
    public: createPublicRoutes(services),
    providers: createProvidersRoutes(services),
    push: createPushRoutes(services),
    translator: createTranslatorRoutes(services),
    secrets: createSecretsRoutes(services, () => providerSecretEntries(services)),
    // A need is as visible as the conversation that raised it.
    needs: createNeedsRoutes({
        needs: services.needs,
        grants: {
            conversationGrants: services.conversationGrants,
            credentialGrants: services.credentialGrants,
            ownerGrants: services.ownerGrants,
            approvals: ownerApprovals(services.config.historyRoot, (id) => unapproveExtension(services, id)),
        },
        visible: (caller, conversationId) => {
            const entry = services.agents.entry(conversationId);
            return entry === undefined || visibleTo(caller, provenanceOf(entry));
        },
    }),
    // The device procedures live in hosts/devices.routes.ts beside the devices they act on, the storage ones beside the
    // disk; merged here, above all three, so no subsystem has to import another's values.
    system: {
        ...createSystemRoutes(services),
        ...createDeviceSystemRoutes(services),
        ...storageRoutes(services),
    },
    usage: createUsageRoutes(services),
    vpn: createVpnRoutes(services),
    offload: createOffloadRoutes(services),
    exit: createExitRoutes(services),
    netdisk: createNetdiskRoutes(services),
});
