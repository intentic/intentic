import type { ContractRoute } from "./protocol/routes.js";
import { contractRoutes, requestPathFor, routeForProcedure, routeNameForRequest, routeShapes } from "./protocol/routes.js";
import { accountsContract } from "./contracts/accounts.contract.js";
import { activityContract } from "./contracts/activity.contract.js";
import { agentContract } from "./contracts/agent.contract.js";
import { agentsContract } from "./contracts/agents.contract.js";
import { approvalsContract } from "./contracts/approvals.contract.js";
import { automationsContract } from "./contracts/automations.contract.js";
import { capabilitiesContract } from "./contracts/capabilities.contract.js";
import { choresContract } from "./contracts/chores.contract.js";
import { ciContract } from "./contracts/ci.contract.js";
import { endpointsContract } from "./contracts/endpoints.contract.js";
import { exitContract } from "./contracts/exit.contract.js";
import { extensionsContract } from "./contracts/extensions.contract.js";
import { personasContract } from "./contracts/personas.contract.js";
import { gitContract } from "./contracts/git.contract.js";
import { historyContract } from "./contracts/history.contract.js";
import { intenticContract } from "./contracts/intentic.contract.js";
import { inventoryContract } from "./contracts/inventory.contract.js";
import { issuesContract } from "./contracts/issues.contract.js";
import { logsContract } from "./contracts/logs.contract.js";
import { loopsContract } from "./contracts/loops.contract.js";
import { panelsContract } from "./contracts/panels.contract.js";
import { portsContract } from "./contracts/ports.contract.js";
import { publicContract } from "./contracts/public.contract.js";
import { prepushContract } from "./contracts/prepush.contract.js";
import { providersContract } from "./contracts/providers.contract.js";
import { pushContract } from "./contracts/push.contract.js";
import { safetyContract } from "./contracts/safety.contract.js";
import { secretsContract } from "./contracts/secrets.contract.js";
import { sessionsContract } from "./contracts/sessions.contract.js";
import { settingsContract } from "./contracts/settings.contract.js";
import { shareContract } from "./contracts/share.contract.js";
import { skillsContract } from "./contracts/skills.contract.js";
import { systemContract } from "./contracts/system.contract.js";
import { translatorContract } from "./contracts/translator.contract.js";
import { usageContract } from "./contracts/usage.contract.js";
import { vpnContract } from "./contracts/vpn.contract.js";
import { workflowsContract } from "./contracts/workflows.contract.js";
import { workspaceContract } from "./contracts/workspace.contract.js";

export { accountsContract } from "./contracts/accounts.contract.js";
export { activityContract } from "./contracts/activity.contract.js";
export { agentContract } from "./contracts/agent.contract.js";
export { agentsContract } from "./contracts/agents.contract.js";
export { approvalsContract } from "./contracts/approvals.contract.js";
export { automationsContract } from "./contracts/automations.contract.js";
export { capabilitiesContract } from "./contracts/capabilities.contract.js";
export { choresContract } from "./contracts/chores.contract.js";
export { ciContract } from "./contracts/ci.contract.js";
export { endpointsContract, type TrialHealth, TrialStatusSchema, type TrialStatusResponse } from "./contracts/endpoints.contract.js";
export { exitContract } from "./contracts/exit.contract.js";
export { extensionsContract } from "./contracts/extensions.contract.js";
export { personasContract } from "./contracts/personas.contract.js";
export { gitContract } from "./contracts/git.contract.js";
export { historyContract } from "./contracts/history.contract.js";
// Not part of `sandboxContract` below: spoken over a device's WebSocket, with the machine implementing it.
export { hostContract } from "./contracts/host.contract.js";
// Same inversion, spoken over a browser extension's socket, with the extension implementing it.
export { webextContract } from "./contracts/webext.contract.js";
// Same inversion again: spoken over a runner's WebSocket, with the runner implementing it.
export { runnerContract } from "./contracts/runner.contract.js";
export { intenticContract } from "./contracts/intentic.contract.js";
export { inventoryContract } from "./contracts/inventory.contract.js";
export { issuesContract } from "./contracts/issues.contract.js";
export { logsContract } from "./contracts/logs.contract.js";
export { REQUEST_ID_EVIDENCE_ROUTE, REQUEST_ID_HEADER } from "./protocol/request-id.js";
export { loopsContract } from "./contracts/loops.contract.js";
export { panelsContract } from "./contracts/panels.contract.js";
export { portsContract } from "./contracts/ports.contract.js";
export { publicContract } from "./contracts/public.contract.js";
export { prepushContract } from "./contracts/prepush.contract.js";
export { providersContract } from "./contracts/providers.contract.js";
export { pushContract } from "./contracts/push.contract.js";
export { safetyContract } from "./contracts/safety.contract.js";
export { secretsContract } from "./contracts/secrets.contract.js";
export { sessionsContract } from "./contracts/sessions.contract.js";
export { settingsContract } from "./contracts/settings.contract.js";
export { shareContract } from "./contracts/share.contract.js";
export { skillsContract } from "./contracts/skills.contract.js";
export { systemContract } from "./contracts/system.contract.js";
export { translatorContract } from "./contracts/translator.contract.js";
export { usageContract } from "./contracts/usage.contract.js";
export { vpnContract } from "./contracts/vpn.contract.js";
export { workflowsContract } from "./contracts/workflows.contract.js";
export { workspaceContract } from "./contracts/workspace.contract.js";
export * from "./events/agent-events.js";
export * from "./events/cards.js";
export * from "./events/resume.js";
export * from "./events/system-events.js";
export * from "./events/transcript.js";
export * from "./policy/card-status.js";
export * from "./text/mentions.js";
export * from "./protocol/sse.js";
export * from "./protocol/routes.js";
export * from "./policy/control-scopes.js";
// The container's directory layout, re-exported since extensions can't import @intentic/constants directly.
export { HISTORY_ROOT, HOST_STATE_ROOT, STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
export * from "./state/workspace-state.js";
export * from "./state/runtime-state.js";
export * from "./state/state-portability.js";
export * from "./state/history-state.js";
export * from "./state/fix-stance.js";
export * from "./state/fix-attempt-plan.js";
// Provider vocabulary bottom-up: agent-runtimes, provider-specs, agent-catalog; three modules since the dependency
// points one way.
export * from "./models/agent-runtimes.js";
export * from "./models/provider-specs.js";
export * from "./models/agent-catalog.js";
export * from "./policy/capability-env.js";
export * from "./policy/command-classes.js";
export * from "./policy/command-run.js";
export * from "./policy/safety-policy.js";
export * from "./policy/credential-material.js";
export * from "./policy/capability-secrets.js";
export * from "./ids/conversation-ids.js";
export * from "./text/documents.js";
export * from "./models/fast-tier.js";
export * from "./protocol/host-protocol.js";
export * from "./protocol/webext-protocol.js";
export * from "./protocol/webext-links.js";
export * from "./protocol/runner-protocol.js";
export * from "./protocol/listener-protocol.js";
export * from "./protocol/container-requirements.js";
export * from "./ids/hostnames.js";
export * from "./policy/overlay-lint.js";
export * from "./models/model-order.js";
export * from "./models/model-pins.js";
export * from "./models/model-roles.js";
export * from "./models/plan-pools.js";
export * from "./text/path-refs.js";
export * from "./models/prompt-complexity.js";
export * from "./policy/output-fields.js";
export * from "./policy/approvals-execution.js";
// Wire shapes, one module per subject area, mirroring `contracts/`; a `{param}` in the route path merges into the same
// flat object, split back into path/body/query. `schemas/internal.ts` is absent: it's vocabulary, not a wire shape.
export * from "./schemas/activity.js";
export * from "./schemas/agent.js";
export * from "./schemas/agents.js";
export * from "./schemas/approvals.js";
export * from "./schemas/automations.js";
export * from "./schemas/capabilities.js";
export * from "./schemas/ci.js";
export * from "./schemas/claude-gate.js";
export * from "./schemas/codebase-health.js";
export * from "./schemas/devices.js";
export * from "./schemas/engines.js";
export * from "./schemas/environment.js";
export * from "./schemas/exit.js";
export * from "./schemas/extension-updates.js";
export * from "./schemas/fast-mode.js";
export * from "./schemas/git.js";
export * from "./schemas/git-history.js";
export * from "./schemas/history.js";
export * from "./schemas/hosts.js";
export * from "./schemas/intentic.js";
export * from "./schemas/inventory.js";
export * from "./schemas/issues.js";
export * from "./schemas/logs.js";
export * from "./schemas/loops.js";
export * from "./schemas/maintenance.js";
export * from "./schemas/marketplace.js";
export * from "./schemas/panels.js";
export * from "./schemas/personas.js";
export * from "./schemas/plan-limits.js";
export * from "./schemas/ports.js";
export * from "./schemas/provider-oauth.js";
export * from "./schemas/provider-subscriptions.js";
export * from "./schemas/public.js";
export * from "./schemas/push.js";
export * from "./schemas/secrets.js";
export * from "./schemas/sessions.js";
export * from "./schemas/settings.js";
export * from "./schemas/share.js";
export * from "./schemas/shared.js";
export * from "./schemas/system.js";
export * from "./schemas/terminal.js";
export * from "./schemas/usage.js";
export * from "./schemas/vpn.js";
export * from "./schemas/webext.js";
export * from "./schemas/workflows.js";
export * from "./schemas/workspace-repos.js";
export * from "./schemas/workspace-search.js";
export * from "./schemas/workspace-setup.js";
export * from "./schemas/workspace-tree.js";
export * from "./state/arrival.js";
export * from "./state/definition.js";
export * from "./policy/search-globs.js";
export * from "./state/starter.js";
export * from "./protocol/terminal-protocol.js";
export * from "./text/title.js";
export * from "./state/versions.js";
export * from "./text/model-answer.js";
export * from "./text/whisper.js";
export * from "./text/workflow-faults.js";

// The aggregated contract; implemented server-side by per-domain route factories, consumed by the browser's typed oRPC
// client. Mounted at the sandbox root, alongside plain Hono routes like /health and /workspace/raw.
export const sandboxContract = {
    accounts: accountsContract,
    activity: activityContract,
    agent: agentContract,
    agents: agentsContract,
    approvals: approvalsContract,
    automations: automationsContract,
    capabilities: capabilitiesContract,
    chores: choresContract,
    ci: ciContract,
    endpoints: endpointsContract,
    extensions: extensionsContract,
    personas: personasContract,
    safety: safetyContract,
    sessions: sessionsContract,
    settings: settingsContract,
    share: shareContract,
    skills: skillsContract,
    intentic: intenticContract,
    git: gitContract,
    history: historyContract,
    workspace: workspaceContract,
    inventory: inventoryContract,
    issues: issuesContract,
    logs: logsContract,
    loops: loopsContract,
    panels: panelsContract,
    ports: portsContract,
    public: publicContract,
    prepush: prepushContract,
    providers: providersContract,
    push: pushContract,
    secrets: secretsContract,
    system: systemContract,
    translator: translatorContract,
    usage: usageContract,
    vpn: vpnContract,
    exit: exitContract,
    workflows: workflowsContract,
};

// Every route in this build, and the names advertised on the hello frame; bound here, not in routes.ts, to avoid a
// load-time cycle back through this file.
export const SANDBOX_ROUTES: readonly ContractRoute[] = contractRoutes(sandboxContract);
export const SANDBOX_ROUTE_NAMES: readonly string[] = SANDBOX_ROUTES.map((route) => route.name);

// Each route's shape, for the failure names alone can't describe: a route both builds have, but whose payload only one
// expects. Computed once at load, since it's too expensive to repeat per connection.
export const SANDBOX_ROUTE_SHAPES: Readonly<Record<string, string>> = routeShapes(sandboxContract);

// The contract route a concrete browser request belongs to, bound to this build's route table.
export const sandboxRouteName = (method: string, pathWithQuery: string): string | undefined =>
    routeNameForRequest(SANDBOX_ROUTES, method, pathWithQuery);

// The method and path a typed call is about to send, bound to this build's route table. Undefined for an undeclared
// procedure; the host gate then refuses it rather than assuming it's harmless.
export const sandboxRequestFor = (procedure: readonly string[], input: unknown): { method: string; path: string } | undefined => {
    const route = routeForProcedure(SANDBOX_ROUTES, procedure);
    return route === undefined ? undefined : { method: route.method, path: requestPathFor(route, input) };
};
