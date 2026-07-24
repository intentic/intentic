import { activityContract } from "./contracts/activity.contract.js";
import { agentContract } from "./contracts/agent.contract.js";
import { agentsContract } from "./contracts/agents.contract.js";
import { automationsContract } from "./contracts/automations.contract.js";
import { capabilitiesContract } from "./contracts/capabilities.contract.js";
import { claudeContract } from "./contracts/claude.contract.js";
import { codexContract } from "./contracts/codex.contract.js";
import { draftsContract } from "./contracts/drafts.contract.js";
import { extensionsContract } from "./contracts/extensions.contract.js";
import { gitContract } from "./contracts/git.contract.js";
import { grokContract } from "./contracts/grok.contract.js";
import { historyContract } from "./contracts/history.contract.js";
import { intenticContract } from "./contracts/intentic.contract.js";
import { inventoryContract } from "./contracts/inventory.contract.js";
import { kimiContract } from "./contracts/kimi.contract.js";
import { logsContract } from "./contracts/logs.contract.js";
import { panelsContract } from "./contracts/panels.contract.js";
import { portsContract } from "./contracts/ports.contract.js";
import { secretsContract } from "./contracts/secrets.contract.js";
import { sessionsContract } from "./contracts/sessions.contract.js";
import { settingsContract } from "./contracts/settings.contract.js";
import { systemContract } from "./contracts/system.contract.js";
import { translatorContract } from "./contracts/translator.contract.js";
import { workspaceContract } from "./contracts/workspace.contract.js";

export { activityContract } from "./contracts/activity.contract.js";
export { agentContract } from "./contracts/agent.contract.js";
export { agentsContract } from "./contracts/agents.contract.js";
export { automationsContract } from "./contracts/automations.contract.js";
export { capabilitiesContract } from "./contracts/capabilities.contract.js";
export { claudeContract } from "./contracts/claude.contract.js";
export { codexContract } from "./contracts/codex.contract.js";
export { draftsContract } from "./contracts/drafts.contract.js";
export { extensionsContract } from "./contracts/extensions.contract.js";
export { gitContract } from "./contracts/git.contract.js";
export { grokContract } from "./contracts/grok.contract.js";
export { historyContract } from "./contracts/history.contract.js";
export { intenticContract } from "./contracts/intentic.contract.js";
export { inventoryContract } from "./contracts/inventory.contract.js";
export { kimiContract } from "./contracts/kimi.contract.js";
export { logsContract } from "./contracts/logs.contract.js";
export { panelsContract } from "./contracts/panels.contract.js";
export { portsContract } from "./contracts/ports.contract.js";
export { secretsContract } from "./contracts/secrets.contract.js";
export { sessionsContract } from "./contracts/sessions.contract.js";
export { settingsContract } from "./contracts/settings.contract.js";
export { systemContract } from "./contracts/system.contract.js";
export { translatorContract } from "./contracts/translator.contract.js";
export { workspaceContract } from "./contracts/workspace.contract.js";
export * from "./effects.js";
export * from "./events.js";
export * from "./sse.js";
export * from "./agent-catalog.js";
export * from "./hostnames.js";
export * from "./schemas.js";
export * from "./terminal-protocol.js";

// The aggregated contract — implemented on the server by the per-domain route factories and consumed by the
// browser's typed oRPC client (ContractRouterClient<typeof sandboxContract>). The wire paths it declares are
// mounted at the sandbox root, so /health and /workspace/raw (plain Hono routes) sit alongside it.
export const sandboxContract = {
    activity: activityContract,
    agent: agentContract,
    agents: agentsContract,
    automations: automationsContract,
    capabilities: capabilitiesContract,
    claude: claudeContract,
    codex: codexContract,
    drafts: draftsContract,
    extensions: extensionsContract,
    sessions: sessionsContract,
    settings: settingsContract,
    intentic: intenticContract,
    git: gitContract,
    grok: grokContract,
    kimi: kimiContract,
    history: historyContract,
    workspace: workspaceContract,
    inventory: inventoryContract,
    logs: logsContract,
    panels: panelsContract,
    ports: portsContract,
    secrets: secretsContract,
    system: systemContract,
    translator: translatorContract,
};
