import type { Samples } from "../smoke-daemon.ts";
import { type SampleFixtures, sampleContext } from "./context.ts";
import { accessProfilesSamples } from "./accessProfiles.samples.ts";
import { accountsSamples } from "./accounts.samples.ts";
import { activitySamples } from "./activity.samples.ts";
import { agentSamples } from "./agent.samples.ts";
import { agentsSamples } from "./agents.samples.ts";
import { approvalsSamples } from "./approvals.samples.ts";
import { areasSamples } from "./areas.samples.ts";
import { auditSamples } from "./audit.samples.ts";
import { automationsSamples } from "./automations.samples.ts";
import { capabilitiesSamples } from "./capabilities.samples.ts";
import { choresSamples } from "./chores.samples.ts";
import { ciSamples } from "./ci.samples.ts";
import { complianceSamples } from "./compliance.samples.ts";
import { diffSamples } from "./diff.samples.ts";
import { endpointsSamples } from "./endpoints.samples.ts";
import { extensionsSamples } from "./extensions.samples.ts";
import { gitSamples } from "./git.samples.ts";
import { historySamples } from "./history.samples.ts";
import { intenticSamples } from "./intentic.samples.ts";
import { issuesSamples } from "./issues.samples.ts";
import { logsSamples } from "./logs.samples.ts";
import { inventorySamples } from "./inventory.samples.ts";
import { loopsSamples } from "./loops.samples.ts";
import { needsSamples } from "./needs.samples.ts";
import { netdiskSamples } from "./netdisk.samples.ts";
import { offloadSamples } from "./offload.samples.ts";
import { orgSamples } from "./org.samples.ts";
import { pagesSamples } from "./pages.samples.ts";
import { panelsSamples } from "./panels.samples.ts";
import { personasSamples } from "./personas.samples.ts";
import { portsSamples } from "./ports.samples.ts";
import { privacySamples } from "./privacy.samples.ts";
import { providersSamples } from "./providers.samples.ts";
import { publicSamples } from "./public.samples.ts";
import { pushSamples } from "./push.samples.ts";
import { runsSamples } from "./runs.samples.ts";
import { safetySamples } from "./safety.samples.ts";
import { secretsSamples } from "./secrets.samples.ts";
import { servicesSamples } from "./services.samples.ts";
import { sessionsSamples } from "./sessions.samples.ts";
import { settingsSamples } from "./settings.samples.ts";
import { shareSamples } from "./share.samples.ts";
import { sharingSamples } from "./sharing.samples.ts";
import { skillsSamples } from "./skills.samples.ts";
import { systemSamples } from "./system.samples.ts";
import { translatorSamples } from "./translator.samples.ts";
import { usageSamples } from "./usage.samples.ts";
import { vpnSamples } from "./vpn.samples.ts";
import { workflowsSamples } from "./workflows.samples.ts";
import { workspaceSamples } from "./workspace.samples.ts";

// One input per served procedure, as the editor hands it to its client, built per group in scripts/samples/<group>.samples.ts so
// each area's inputs sit beside nothing else. Ids and records come from the fixture itself (context.ts).
export const samplesOf = (fixtures: SampleFixtures, now: number): Samples => {
    const context = sampleContext(fixtures, now);
    return {
        system: systemSamples(context),
        agents: agentsSamples(context),
        agent: agentSamples(context),
        sessions: sessionsSamples(context),
        workspace: workspaceSamples(context),
        git: gitSamples(context),
        diff: diffSamples(context),
        accounts: accountsSamples(context),
        sharing: sharingSamples(context),
        translator: translatorSamples(context),
        providers: providersSamples(context),
        endpoints: endpointsSamples(context),
        settings: settingsSamples(context),
        safety: safetySamples(context),
        compliance: complianceSamples(context),
        privacy: privacySamples(context),
        vpn: vpnSamples(context),
        offload: offloadSamples(context),
        runs: runsSamples(context),
        ci: ciSamples(context),
        chores: choresSamples(context),
        automations: automationsSamples(context),
        workflows: workflowsSamples(context),
        loops: loopsSamples(context),
        capabilities: capabilitiesSamples(context),
        skills: skillsSamples(context),
        personas: personasSamples(context),
        audit: auditSamples(context),
        org: orgSamples(context),
        areas: areasSamples(context),
        accessProfiles: accessProfilesSamples(context),
        services: servicesSamples(context),
        usage: usageSamples(context),
        secrets: secretsSamples(context),
        needs: needsSamples(context),
        ports: portsSamples(context),
        panels: panelsSamples(context),
        extensions: extensionsSamples(context),
        approvals: approvalsSamples(context),
        activity: activitySamples(context),
        history: historySamples(context),
        intentic: intenticSamples(context),
        inventory: inventorySamples(context),
        netdisk: netdiskSamples(context),
        pages: pagesSamples(context),
        public: publicSamples(context),
        push: pushSamples(context),
        share: shareSamples(context),
        issues: issuesSamples(context),
        logs: logsSamples(context),
    };
};
