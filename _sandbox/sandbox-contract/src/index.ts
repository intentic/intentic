import type { ContractRoute } from "./routes.js";
import { contractRoutes, requestPathFor, routeForProcedure, routeNameForRequest } from "./routes.js";
import { activityContract } from "./contracts/activity.contract.js";
import { agentContract } from "./contracts/agent.contract.js";
import { agentsContract } from "./contracts/agents.contract.js";
import { automationsContract } from "./contracts/automations.contract.js";
import { capabilitiesContract } from "./contracts/capabilities.contract.js";
import { choresContract } from "./contracts/chores.contract.js";
import { ciContract } from "./contracts/ci.contract.js";
import { claudeContract } from "./contracts/claude.contract.js";
import { draftsContract } from "./contracts/drafts.contract.js";
import { endpointsContract } from "./contracts/endpoints.contract.js";
import { extensionsContract } from "./contracts/extensions.contract.js";
import { identitiesContract } from "./contracts/identities.contract.js";
import { gitContract } from "./contracts/git.contract.js";
import { grokContract } from "./contracts/grok.contract.js";
import { historyContract } from "./contracts/history.contract.js";
import { intenticContract } from "./contracts/intentic.contract.js";
import { inventoryContract } from "./contracts/inventory.contract.js";
import { logsContract } from "./contracts/logs.contract.js";
import { loopsContract } from "./contracts/loops.contract.js";
import { panelsContract } from "./contracts/panels.contract.js";
import { portsContract } from "./contracts/ports.contract.js";
import { publicContract } from "./contracts/public.contract.js";
import { prepushContract } from "./contracts/prepush.contract.js";
import { providersContract } from "./contracts/providers.contract.js";
import { pushContract } from "./contracts/push.contract.js";
import { secretsContract } from "./contracts/secrets.contract.js";
import { sessionsContract } from "./contracts/sessions.contract.js";
import { settingsContract } from "./contracts/settings.contract.js";
import { systemContract } from "./contracts/system.contract.js";
import { translatorContract } from "./contracts/translator.contract.js";
import { usageContract } from "./contracts/usage.contract.js";
import { vpnContract } from "./contracts/vpn.contract.js";
import { workflowsContract } from "./contracts/workflows.contract.js";
import { workspaceContract } from "./contracts/workspace.contract.js";

export { activityContract } from "./contracts/activity.contract.js";
export { agentContract } from "./contracts/agent.contract.js";
export { agentsContract } from "./contracts/agents.contract.js";
export { automationsContract } from "./contracts/automations.contract.js";
export { capabilitiesContract } from "./contracts/capabilities.contract.js";
export { choresContract } from "./contracts/chores.contract.js";
export { ciContract } from "./contracts/ci.contract.js";
export { claudeContract } from "./contracts/claude.contract.js";
export { draftsContract } from "./contracts/drafts.contract.js";
export { endpointsContract } from "./contracts/endpoints.contract.js";
export { extensionsContract } from "./contracts/extensions.contract.js";
export { identitiesContract } from "./contracts/identities.contract.js";
export { gitContract } from "./contracts/git.contract.js";
export { grokContract } from "./contracts/grok.contract.js";
export { historyContract } from "./contracts/history.contract.js";
/* Deliberately NOT part of `sandboxContract` below: that map is the daemon's own HTTP surface, and this one is
 * spoken the other way round — over a connected computer's WebSocket, with the MACHINE implementing it. */
export { hostContract } from "./contracts/host.contract.js";
export { intenticContract } from "./contracts/intentic.contract.js";
export { inventoryContract } from "./contracts/inventory.contract.js";
export { logsContract } from "./contracts/logs.contract.js";
export { loopsContract } from "./contracts/loops.contract.js";
export { panelsContract } from "./contracts/panels.contract.js";
export { portsContract } from "./contracts/ports.contract.js";
export { publicContract } from "./contracts/public.contract.js";
export { prepushContract } from "./contracts/prepush.contract.js";
export { providersContract } from "./contracts/providers.contract.js";
export { pushContract } from "./contracts/push.contract.js";
export { secretsContract } from "./contracts/secrets.contract.js";
export { sessionsContract } from "./contracts/sessions.contract.js";
export { settingsContract } from "./contracts/settings.contract.js";
export { systemContract } from "./contracts/system.contract.js";
export { translatorContract } from "./contracts/translator.contract.js";
export { usageContract } from "./contracts/usage.contract.js";
export { vpnContract } from "./contracts/vpn.contract.js";
export { workflowsContract } from "./contracts/workflows.contract.js";
export { workspaceContract } from "./contracts/workspace.contract.js";
export * from "./events.js";
export * from "./sse.js";
export * from "./routes.js";
/* THE CONTAINER'S FIXED DIRECTORY LAYOUT, re-exported so extensions can reach it.
 *
 * The names are defined once in @intentic/constants, which sits at the bottom of the dependency graph. An
 * EXTENSION may not import that package — the boundary rule (.oxlintrc.json, _extensions/README.md) allows
 * only the SDK halves and this contract, so that an extension cannot couple itself to app or engine internals.
 * That rule is right, and it left extensions with no way to name the workspace root except by spelling it.
 *
 * Re-exporting here is what closes that gap without widening the boundary: the layout is exactly the kind of
 * thing this package already carries — shared vocabulary both sides of the wire must agree on, alongside the
 * state-file table below — and there is still one definition, in one place, that everything resolves to. */
export { HISTORY_ROOT, HOST_STATE_ROOT, STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
export * from "./workspace-state.js";
export * from "./runtime-state.js";
export * from "./state-portability.js";
export * from "./history-state.js";
export * from "./agent-catalog.js";
export * from "./host-protocol.js";
export * from "./listener-protocol.js";
export * from "./hostnames.js";
export * from "./model-order.js";
export * from "./path-refs.js";
export * from "./quick-model.js";
export * from "./output-fields.js";
export * from "./publish-drafts.js";
export * from "./schemas.js";
export * from "./search-globs.js";
export * from "./terminal-protocol.js";
export * from "./title.js";
export * from "./versions.js";
export * from "./workflow-faults.js";

// The aggregated contract — implemented on the server by the per-domain route factories and consumed by the
// browser's typed oRPC client (ContractRouterClient<typeof sandboxContract>). The wire paths it declares are
// mounted at the sandbox root, so /health and /workspace/raw (plain Hono routes) sit alongside it.
export const sandboxContract = {
    activity: activityContract,
    agent: agentContract,
    agents: agentsContract,
    automations: automationsContract,
    capabilities: capabilitiesContract,
    chores: choresContract,
    ci: ciContract,
    claude: claudeContract,
    drafts: draftsContract,
    endpoints: endpointsContract,
    extensions: extensionsContract,
    identities: identitiesContract,
    sessions: sessionsContract,
    settings: settingsContract,
    intentic: intenticContract,
    git: gitContract,
    grok: grokContract,
    history: historyContract,
    workspace: workspaceContract,
    inventory: inventoryContract,
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
    workflows: workflowsContract,
};

// Every route in THIS build of the contract, and the names the daemon advertises on its hello frame. Bound here
// rather than in routes.ts so that module stays a pure function of whatever contract it is handed — importing
// `sandboxContract` from there would close a load-time cycle back through this file. See routes.ts for why a
// daemon advertises its route surface at all.
export const SANDBOX_ROUTES: readonly ContractRoute[] = contractRoutes(sandboxContract);
export const SANDBOX_ROUTE_NAMES: readonly string[] = SANDBOX_ROUTES.map((route) => route.name);

// The contract route a concrete browser request belongs to, bound to this build's route table.
export const sandboxRouteName = (method: string, pathWithQuery: string): string | undefined =>
    routeNameForRequest(SANDBOX_ROUTES, method, pathWithQuery);

// The method and concrete path a TYPED call is about to put on the wire, bound to this build's route table.
// Undefined when the procedure is not one this contract declares, which a typed caller cannot reach — the host
// gate treats it as a refusal rather than assuming it is harmless.
export const sandboxRequestFor = (procedure: readonly string[], input: unknown): { method: string; path: string } | undefined => {
    const route = routeForProcedure(SANDBOX_ROUTES, procedure);
    return route === undefined ? undefined : { method: route.method, path: requestPathFor(route, input) };
};
