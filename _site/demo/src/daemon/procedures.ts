import type { FixtureRouter } from "@intentic/contract-serve";
import { accessDoors } from "../fixture/access";
import { secretDoors } from "./account/secrets";
import { skillDoors } from "./extensions/skills";
import { accountsDoors } from "./account/accounts.handler";
import { activityDoors } from "./board/activity.handler";
import { agentDoors } from "./board/agent.handler";
import { agentsDoors } from "./board/agents.handler";
import { approvalsDoors } from "./board/approvals.handler";
import { areasDoors } from "./account/areas.handler";
import { auditDoors } from "./account/audit.handler";
import { automationsDoors } from "./board/automations.handler";
import { capabilitiesDoors } from "./account/capabilities.handler";
import { choresDoors } from "./board/chores.handler";
import { ciDoors } from "./board/ci.handler";
import { complianceDoors } from "./account/compliance.handler";
import { diffDoors } from "./git/diff.handler";
import { endpointsDoors } from "./account/endpoints.handler";
import { extensionsDoors } from "./extensions/extensions.handler";
import { gitDoors } from "./git/git.handler";
import { historyDoors } from "./git/history.handler";
import { intenticDoors } from "./machine/intentic.handler";
import { issuesDoors } from "./extensions/issues.handler";
import { logsDoors } from "./machine/logs.handler";
import { inventoryDoors } from "./machine/inventory.handler";
import { loopsDoors } from "./board/loops.handler";
import { needsDoors } from "./board/needs.handler";
import { netdiskDoors } from "./machine/netdisk.handler";
import { offloadDoors } from "./machine/offload.handler";
import { orgDoors } from "./account/org.handler";
import { pagesDoors } from "./board/pages.handler";
import { panelsDoors } from "./extensions/panels.handler";
import { personasDoors } from "./extensions/personas.handler";
import { portsDoors } from "./machine/ports.handler";
import { privacyDoors } from "./account/privacy.handler";
import { providersDoors } from "./account/providers.handler";
import { publicDoors } from "./extensions/public.handler";
import { pushDoors } from "./machine/push.handler";
import { runsDoors } from "./board/runs.handler";
import { safetyDoors } from "./account/safety.handler";
import { sessionsDoors } from "./board/sessions.handler";
import { settingsDoors } from "./account/settings.handler";
import { shareDoors } from "./extensions/share.handler";
import { sharingDoors } from "./account/sharing.handler";
import { systemDoors } from "./machine/system.handler";
import { translatorDoors } from "./account/translator.handler";
import { usageDoors } from "./account/usage.handler";
import { vpnDoors } from "./machine/vpn.handler";
import { workflowsDoors } from "./board/workflows.handler";
import { workspaceDoors } from "./workspace/workspace.handler";

// THE FIXTURE DAEMON'S PROCEDURES, assembled: each contract group is answered in <area>/<group>.handler.ts (or, for the
// stores shared with other seams, in the module that holds that store), and this table only names them.
// Every procedure the fixture serves; an empty-but-real area answers its contract's empty shape, not a 404.
export const procedures = {
    system: systemDoors,
    agents: agentsDoors,
    agent: agentDoors,
    sessions: sessionsDoors,
    workspace: workspaceDoors,
    git: gitDoors,
    diff: diffDoors,
    accounts: accountsDoors,
    translator: translatorDoors,
    providers: providersDoors,
    endpoints: endpointsDoors,
    settings: settingsDoors,
    safety: safetyDoors,
    privacy: privacyDoors,
    compliance: complianceDoors,
    vpn: vpnDoors,
    offload: offloadDoors,
    runs: runsDoors,
    ci: ciDoors,
    chores: choresDoors,
    automations: automationsDoors,
    workflows: workflowsDoors,
    loops: loopsDoors,
    capabilities: capabilitiesDoors,
    skills: skillDoors,
    personas: personasDoors,
    audit: auditDoors,
    org: orgDoors,
    ...accessDoors,
    areas: areasDoors,
    usage: usageDoors,
    // The values a person keeps and the rules on each, answered for real against the fixture store (daemon/secrets.ts).
    secrets: secretDoors,
    needs: needsDoors,
    ports: portsDoors,
    panels: panelsDoors,
    extensions: extensionsDoors,
    approvals: approvalsDoors,
    activity: activityDoors,
    history: historyDoors,
    intentic: intenticDoors,
    inventory: inventoryDoors,
    netdisk: netdiskDoors,
    pages: pagesDoors,
    public: publicDoors,
    push: pushDoors,
    share: shareDoors,
    // Model accounts brought in from another of the owner's sandboxes, and what this one could share (sharing.handler.ts).
    sharing: sharingDoors,
    issues: issuesDoors,
    logs: logsDoors,
} satisfies FixtureRouter;
