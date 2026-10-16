import { getEventIteratorSchemaDetails, isContractProcedure } from "@orpc/contract";
import type { z } from "zod";
import { RAW_JSON_ROUTES } from "./protocol/raw/raw-json-routes.js";
import { RAW_ROUTE_LIST } from "./protocol/raw/raw-routes.js";
import type { ContractRoute } from "./protocol/routes.js";
import { contractRoutes, rawRouteFingerprintsOf, requestPathFor, routeForProcedure, routeNameForRequest, routeShapes, servedRoute } from "./protocol/routes.js";
import { accountsContract } from "./contracts/accounts.contract.js";
import { activityContract } from "./contracts/activity.contract.js";
import { agentContract } from "./contracts/agent.contract.js";
import { agentsContract } from "./contracts/agents.contract.js";
import { approvalsContract } from "./contracts/approvals.contract.js";
import { areasContract } from "./contracts/areas.contract.js";
import { auditContract } from "./contracts/audit.contract.js";
import { automationsContract } from "./contracts/automations.contract.js";
import { capabilitiesContract } from "./contracts/capabilities.contract.js";
import { choresContract } from "./contracts/chores.contract.js";
import { ciContract } from "./contracts/ci.contract.js";
import { complianceContract } from "./contracts/compliance.contract.js";
import { diffContract } from "./contracts/diff.contract.js";
import { endpointsContract } from "./contracts/endpoints.contract.js";
import { exitContract } from "./contracts/exit.contract.js";
import { extensionsContract } from "./contracts/extensions.contract.js";
import { gitContract } from "./contracts/git.contract.js";
import { historyContract } from "./contracts/history.contract.js";
import { intenticContract } from "./contracts/intentic.contract.js";
import { inventoryContract } from "./contracts/inventory.contract.js";
import { issuesContract } from "./contracts/issues.contract.js";
import { logsContract } from "./contracts/logs.contract.js";
import { loopsContract } from "./contracts/loops.contract.js";
import { needsContract } from "./contracts/needs.contract.js";
import { netdiskContract } from "./contracts/netdisk.contract.js";
import { offloadContract } from "./contracts/offload.contract.js";
import { orgContract } from "./contracts/org.contract.js";
import { pagesContract } from "./contracts/pages.contract.js";
import { panelsContract } from "./contracts/panels.contract.js";
import { personasContract } from "./contracts/personas.contract.js";
import { portsContract } from "./contracts/ports.contract.js";
import { privacyContract } from "./contracts/privacy.contract.js";
import { providersContract } from "./contracts/providers.contract.js";
import { publicContract } from "./contracts/public.contract.js";
import { pushContract } from "./contracts/push.contract.js";
import { runsContract } from "./contracts/runs.contract.js";
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

// The container's directory layout, re-exported since extensions can't import @intentic/constants directly.
export { HISTORY_ROOT, HOST_STATE_ROOT, STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";

// The aggregated contract; implemented server-side by per-domain route factories, consumed by the browser's typed oRPC
// client. Mounted at the sandbox root, alongside plain Hono routes like /health and /workspace/raw.
export const sandboxContract = {
    accounts: accountsContract,
    activity: activityContract,
    agent: agentContract,
    agents: agentsContract,
    approvals: approvalsContract,
    areas: areasContract,
    audit: auditContract,
    automations: automationsContract,
    capabilities: capabilitiesContract,
    chores: choresContract,
    ci: ciContract,
    compliance: complianceContract,
    diff: diffContract,
    endpoints: endpointsContract,
    exit: exitContract,
    extensions: extensionsContract,
    git: gitContract,
    history: historyContract,
    intentic: intenticContract,
    inventory: inventoryContract,
    issues: issuesContract,
    logs: logsContract,
    loops: loopsContract,
    needs: needsContract,
    netdisk: netdiskContract,
    offload: offloadContract,
    org: orgContract,
    pages: pagesContract,
    panels: panelsContract,
    personas: personasContract,
    ports: portsContract,
    privacy: privacyContract,
    providers: providersContract,
    public: publicContract,
    push: pushContract,
    runs: runsContract,
    safety: safetyContract,
    secrets: secretsContract,
    sessions: sessionsContract,
    settings: settingsContract,
    share: shareContract,
    skills: skillsContract,
    system: systemContract,
    translator: translatorContract,
    usage: usageContract,
    vpn: vpnContract,
    workflows: workflowsContract,
    workspace: workspaceContract,
};

// Every route in this build, and the names advertised on the hello frame; bound here, not in routes.ts, to avoid a
// load-time cycle back through this file.
export const SANDBOX_ROUTES: readonly ContractRoute[] = contractRoutes(sandboxContract);
export const SANDBOX_ROUTE_NAMES: readonly string[] = SANDBOX_ROUTES.map((route) => route.name);

// Each route's shape, for the failure names alone can't describe: a route both builds have, but whose payload only one
// expects. Computed on the first ask and kept, since it's too expensive to repeat per connection — and too expensive to
// pay at load: turning every route's schemas into JSON Schema was a third of a second of a phone's startup at 4× CPU
// throttle, for a comparison a browser only makes when it has a disagreement to explain (the version card). The daemon
// asks on its first hello.
let fingerprints: Readonly<Record<string, string>> | undefined;
export const sandboxRouteFingerprints = (): Readonly<Record<string, string>> => (fingerprints ??= routeShapes(sandboxContract));

// The hand-written routes beside the procedures, advertised on their own field of the hello frame rather than mixed
// into `routes`: a browser older than this build reads an unknown name in `routes` as evidence that IT is the stale
// side, and every raw name arriving there at once would have had it say so on every connection. Absent, as from every
// daemon before the field, means no evidence — the same "assume it answers" an unknown route surface gets.
export const RAW_ROUTE_NAMES: readonly string[] = RAW_ROUTE_LIST.map((route) => route.name);

// Each raw JSON route's shape, memoised like the procedures' for the same reason: the walk turns every schema into JSON
// Schema, which is startup time a browser should only spend when it has a disagreement to explain. The routes that
// carry no schemas at all (a WebSocket upgrade, a byte stream) are named above but fingerprinted nowhere, and an
// unfingerprinted route is compared on nothing.
let rawFingerprints: Readonly<Record<string, string>> | undefined;
export const rawRouteFingerprints = (): Readonly<Record<string, string>> => (rawFingerprints ??= rawRouteFingerprintsOf(RAW_JSON_ROUTES));

// The contract route a concrete browser request belongs to, bound to this build's route table.
export const sandboxRouteName = (method: string, pathWithQuery: string): string | undefined =>
    routeNameForRequest(SANDBOX_ROUTES, method, pathWithQuery);

// The route of either kind that serves a request to the daemon, bound to this build's tables; its meta is the policy the
// daemon holds the request to, and undefined means nothing serves it.
export const sandboxRouteFor = (method: string, pathWithQuery: string): ContractRoute | undefined =>
    servedRoute(RAW_ROUTE_LIST, SANDBOX_ROUTES, method, pathWithQuery);

// The method and path a typed call is about to send, bound to this build's route table. Undefined for an undeclared
// procedure; the host gate then refuses it rather than assuming it's harmless.
export const sandboxRequestFor = (procedure: readonly string[], input: unknown): { method: string; path: string } | undefined => {
    const route = routeForProcedure(SANDBOX_ROUTES, procedure);
    return route === undefined ? undefined : { method: route.method, path: requestPathFor(route, input) };
};

// The schema a procedure's answer is parsed by, bound to this build's contract; undefined for a streamed answer, which
// passes as it arrives, since a frame kind this build does not know must not end the stream.
export const sandboxAnswerSchema = (procedure: readonly string[]): z.ZodType | undefined => {
    const [group = "", name = ""] = procedure;
    const declared = (sandboxContract as Readonly<Record<string, Readonly<Record<string, unknown>>>>)[group]?.[name];
    const schema = isContractProcedure(declared) ? declared["~orpc"].outputSchema : undefined;
    return schema === undefined || getEventIteratorSchemaDetails(schema) !== undefined ? undefined : (schema as z.ZodType);
};
