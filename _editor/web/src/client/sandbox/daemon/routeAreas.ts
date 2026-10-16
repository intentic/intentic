import { t } from "@intentic/ui/i18n";

// THE PARTS OF THE PRODUCT A ROUTE BELONGS TO, in the words a reader would use. Two readers: the Sandbox page's card
// on a sandbox and app that disagree (driftReport.ts, one row per area), and the sentence a single call that failed
// for that reason comes back as (useDaemonRoutes.ts), which names the area rather than quoting a dotted route id
// nobody outside this codebase can read.

// Each contract group named as the product names it, with the screen it serves. Without this the card reports
// `agent` and `agents` as two things a reader is supposed to tell apart — a distinction only the contract makes.
// A group with no entry has no name here: an unknown group means the OTHER side has a feature this build predates, so
// there is no honest label for it. Each entry reads the catalog when asked rather than at import, so a language
// switched after the page loaded names the areas in that language.
export interface AreaName {
    readonly label: string;
    readonly where: string;
}
const AREAS = {
    accounts: () => ({ label: t(`sandbox.driftReport.areas.accounts.label`), where: t(`sandbox.driftReport.areas.accounts.where`) }),
    activity: () => ({ label: t(`sandbox.driftReport.areas.activity.label`), where: t(`sandbox.driftReport.areas.activity.where`) }),
    agent: () => ({ label: t(`sandbox.driftReport.areas.agent.label`), where: t(`sandbox.driftReport.areas.agent.where`) }),
    agents: () => ({ label: t(`sandbox.driftReport.areas.agents.label`), where: t(`sandbox.driftReport.areas.agents.where`) }),
    approvals: () => ({ label: t(`sandbox.driftReport.areas.approvals.label`), where: t(`sandbox.driftReport.areas.approvals.where`) }),
    areas: () => ({ label: t(`sandbox.driftReport.areas.areas.label`), where: t(`sandbox.driftReport.areas.areas.where`) }),
    audit: () => ({ label: t(`sandbox.driftReport.areas.audit.label`), where: t(`sandbox.driftReport.areas.audit.where`) }),
    automations: () => ({ label: t(`sandbox.driftReport.areas.automations.label`), where: t(`sandbox.driftReport.areas.automations.where`) }),
    capabilities: () => ({ label: t(`sandbox.driftReport.areas.capabilities.label`), where: t(`sandbox.driftReport.areas.capabilities.where`) }),
    chores: () => ({ label: t(`sandbox.driftReport.areas.chores.label`), where: t(`sandbox.driftReport.areas.chores.where`) }),
    ci: () => ({ label: t(`sandbox.driftReport.areas.ci.label`), where: t(`sandbox.driftReport.areas.ci.where`) }),
    compliance: () => ({ label: t(`sandbox.driftReport.areas.compliance.label`), where: t(`sandbox.driftReport.areas.compliance.where`) }),
    diff: () => ({ label: t(`sandbox.driftReport.areas.diff.label`), where: t(`sandbox.driftReport.areas.diff.where`) }),
    endpoints: () => ({ label: t(`sandbox.driftReport.areas.endpoints.label`), where: t(`sandbox.driftReport.areas.endpoints.where`) }),
    exit: () => ({ label: t(`sandbox.driftReport.areas.exit.label`), where: t(`sandbox.driftReport.areas.exit.where`) }),
    extensions: () => ({ label: t(`sandbox.driftReport.areas.extensions.label`), where: t(`sandbox.driftReport.areas.extensions.where`) }),
    git: () => ({ label: t(`sandbox.driftReport.areas.git.label`), where: t(`sandbox.driftReport.areas.git.where`) }),
    history: () => ({ label: t(`sandbox.driftReport.areas.history.label`), where: t(`sandbox.driftReport.areas.history.where`) }),
    intentic: () => ({ label: t(`sandbox.driftReport.areas.intentic.label`), where: t(`sandbox.driftReport.areas.intentic.where`) }),
    inventory: () => ({ label: t(`sandbox.driftReport.areas.inventory.label`), where: t(`sandbox.driftReport.areas.inventory.where`) }),
    issues: () => ({ label: t(`sandbox.driftReport.areas.issues.label`), where: t(`sandbox.driftReport.areas.issues.where`) }),
    logs: () => ({ label: t(`sandbox.driftReport.areas.logs.label`), where: t(`sandbox.driftReport.areas.logs.where`) }),
    loops: () => ({ label: t(`sandbox.driftReport.areas.loops.label`), where: t(`sandbox.driftReport.areas.loops.where`) }),
    needs: () => ({ label: t(`sandbox.driftReport.areas.needs.label`), where: t(`sandbox.driftReport.areas.needs.where`) }),
    netdisk: () => ({ label: t(`sandbox.driftReport.areas.netdisk.label`), where: t(`sandbox.driftReport.areas.netdisk.where`) }),
    offload: () => ({ label: t(`sandbox.driftReport.areas.offload.label`), where: t(`sandbox.driftReport.areas.offload.where`) }),
    org: () => ({ label: t(`sandbox.driftReport.areas.org.label`), where: t(`sandbox.driftReport.areas.org.where`) }),
    panels: () => ({ label: t(`sandbox.driftReport.areas.panels.label`), where: t(`sandbox.driftReport.areas.panels.where`) }),
    pages: () => ({ label: t(`sandbox.driftReport.areas.pages.label`), where: t(`sandbox.driftReport.areas.pages.where`) }),
    personas: () => ({ label: t(`sandbox.driftReport.areas.personas.label`), where: t(`sandbox.driftReport.areas.personas.where`) }),
    ports: () => ({ label: t(`sandbox.driftReport.areas.ports.label`), where: t(`sandbox.driftReport.areas.ports.where`) }),
    privacy: () => ({ label: t(`sandbox.driftReport.areas.privacy.label`), where: t(`sandbox.driftReport.areas.privacy.where`) }),
    providers: () => ({ label: t(`sandbox.driftReport.areas.providers.label`), where: t(`sandbox.driftReport.areas.providers.where`) }),
    public: () => ({ label: t(`sandbox.driftReport.areas.public.label`), where: t(`sandbox.driftReport.areas.public.where`) }),
    push: () => ({ label: t(`sandbox.driftReport.areas.push.label`), where: t(`sandbox.driftReport.areas.push.where`) }),
    runs: () => ({ label: t(`sandbox.driftReport.areas.runs.label`), where: t(`sandbox.driftReport.areas.runs.where`) }),
    safety: () => ({ label: t(`sandbox.driftReport.areas.safety.label`), where: t(`sandbox.driftReport.areas.safety.where`) }),
    secrets: () => ({ label: t(`sandbox.driftReport.areas.secrets.label`), where: t(`sandbox.driftReport.areas.secrets.where`) }),
    sessions: () => ({ label: t(`sandbox.driftReport.areas.sessions.label`), where: t(`sandbox.driftReport.areas.sessions.where`) }),
    settings: () => ({ label: t(`sandbox.driftReport.areas.settings.label`), where: t(`sandbox.driftReport.areas.settings.where`) }),
    share: () => ({ label: t(`sandbox.driftReport.areas.share.label`), where: t(`sandbox.driftReport.areas.share.where`) }),
    skills: () => ({ label: t(`sandbox.driftReport.areas.skills.label`), where: t(`sandbox.driftReport.areas.skills.where`) }),
    // Named for what a reader would actually open, not for the group: "the sandbox itself" would collide with the
    // row above that IS the sandbox, and "internals" tells nobody which screen to distrust.
    system: () => ({ label: t(`sandbox.driftReport.areas.system.label`), where: t(`sandbox.driftReport.areas.system.where`) }),
    translator: () => ({ label: t(`sandbox.driftReport.areas.translator.label`), where: t(`sandbox.driftReport.areas.translator.where`) }),
    usage: () => ({ label: t(`sandbox.driftReport.areas.usage.label`), where: t(`sandbox.driftReport.areas.usage.where`) }),
    vpn: () => ({ label: t(`sandbox.driftReport.areas.vpn.label`), where: t(`sandbox.driftReport.areas.vpn.where`) }),
    workflows: () => ({ label: t(`sandbox.driftReport.areas.workflows.label`), where: t(`sandbox.driftReport.areas.workflows.where`) }),
    workspace: () => ({ label: t(`sandbox.driftReport.areas.workspace.label`), where: t(`sandbox.driftReport.areas.workspace.where`) }),
} satisfies Record<string, () => AreaName>;
const AREA_BY_GROUP = new Map(Object.entries(AREAS));

// Which part of the product a route belongs to. A procedure carries it as its first dotted segment (`system.info`); a
// hand-written one carries it as the first segment of its path (`GET /system/links`), so both land in the row a reader
// would look for rather than one row per verb. A name with neither is its own group, not a hole in the list.
export const routeGroup = (route: string): string => {
    const path = route.includes(` `) ? route.slice(route.indexOf(` `) + 1) : undefined;
    return path === undefined ? (route.split(`.`)[0] ?? route) : (path.split(`/`).find((segment) => segment.length > 0) ?? route);
};

// The plain name of the area a group is, or undefined for a group the table has no name for.
export const namedArea = (group: string): AreaName | undefined => AREA_BY_GROUP.get(group)?.();

// The plain name of the area a route belongs to, or undefined where there is none.
export const routeArea = (route: string): AreaName | undefined => namedArea(routeGroup(route));
