import { createActivityRoutes } from "./activity/activity.routes.js";
import { createAgentRoutes } from "./agent/agent.routes.js";
import { createMintedRoutes } from "./minted/minted.routes.js";
import { createProvidersRoutes } from "./agent/providers.routes.js";
import { createAgentsRoutes } from "./agents/agents.routes.js";
import { createTranslatorRoutes } from "./agent/translator.routes.js";
import { createAutomationsRoutes } from "./automations/automations.routes.js";
import { createCapabilitiesRoutes } from "./capabilities/capabilities.routes.js";
import { createPersonasRoutes } from "./personas/personas.routes.js";
import { createChoresRoutes } from "./chores/chores.routes.js";
import { createCiRoutes } from "./ci/ci.routes.js";
import { createClaudeRoutes } from "./claude/claude.routes.js";
import { createCursorRoutes } from "./cursor/cursor.routes.js";
import type { Services } from "./composition.js";
import { createApprovalsRoutes } from "./approvals/approvals.routes.js";
import { createExtensionsRoutes } from "./extensions/extensions.routes.js";
import { createEndpointsRoutes } from "./endpoints/endpoints.routes.js";
import { createGitRoutes } from "./git/git.routes.js";
import { createGrokRoutes } from "./grok/grok.routes.js";
import { createHistoryRoutes } from "./history/history.routes.js";
import { createIntenticRoutes } from "./intentic/intentic.routes.js";
import { createInventoryRoutes } from "./inventory/inventory.routes.js";
import { createIssuesRoutes } from "./issues/issues.routes.js";
import { createLogsRoutes } from "./logs/logs.routes.js";
import { createLoopsRoutes } from "./loops/loops.routes.js";
import { createWorkflowsRoutes } from "./workflows/workflows.routes.js";
import { createPanelsRoutes } from "./panels/panels.routes.js";
import { createPortsRoutes } from "./ports/ports.routes.js";
import { createPublicRoutes } from "./public/public.routes.js";
import { createPrepushRoutes } from "./prepush/prepush.routes.js";
import { createPushRoutes } from "./push/push.routes.js";
import { createSecretsRoutes } from "./secrets/secrets.routes.js";
import { createSessionsRoutes } from "./sessions/sessions.routes.js";
import { createSafetyRoutes } from "./safety/safety.routes.js";
import { createSettingsRoutes } from "./settings/settings.routes.js";
import { createShareRoutes } from "./share/share.routes.js";
import { createSkillsRoutes } from "./settings/skills.routes.js";
import { createSystemRoutes } from "./system/system.routes.js";
import { createUsageRoutes } from "./usage/usage.routes.js";
import { createExitRoutes } from "./exit/exit.routes.js";
import { createVpnRoutes } from "./vpn/vpn.routes.js";
import { createWorkspaceRoutes } from "./workspace/workspace.routes.js";

// The implemented oRPC router, the per-domain route factories assembled into the sandboxContract shape. The
// OpenAPIHandler in app.ts serves it.
export const createRouter = (services: Services) => ({
    activity: createActivityRoutes(services),
    agent: createAgentRoutes(services),
    agents: createAgentsRoutes(services),
    automations: createAutomationsRoutes(services),
    capabilities: createCapabilitiesRoutes(services),
    chores: createChoresRoutes(services),
    ci: createCiRoutes(services),
    claude: createClaudeRoutes(services),
    cursor: createCursorRoutes(services),
    approvals: createApprovalsRoutes(services),
    extensions: createExtensionsRoutes(services),
    personas: createPersonasRoutes(services),
    safety: createSafetyRoutes(services),
    sessions: createSessionsRoutes(services),
    settings: createSettingsRoutes(services),
    share: createShareRoutes(services),
    skills: createSkillsRoutes(services),
    intentic: createIntenticRoutes(services),
    endpoints: createEndpointsRoutes(services),
    git: createGitRoutes(services),
    grok: createGrokRoutes(services),
    history: createHistoryRoutes(services),
    workspace: createWorkspaceRoutes(services),
    inventory: createInventoryRoutes(services),
    issues: createIssuesRoutes(services),
    logs: createLogsRoutes(services),
    loops: createLoopsRoutes(services),
    workflows: createWorkflowsRoutes(services),
    panels: createPanelsRoutes(services),
    ports: createPortsRoutes(services),
    public: createPublicRoutes(services),
    prepush: createPrepushRoutes(services),
    keys: createMintedRoutes(services),
    providers: createProvidersRoutes(services),
    push: createPushRoutes(services),
    translator: createTranslatorRoutes(services),
    secrets: createSecretsRoutes(services),
    system: createSystemRoutes(services),
    usage: createUsageRoutes(services),
    vpn: createVpnRoutes(services),
    exit: createExitRoutes(services),
});
