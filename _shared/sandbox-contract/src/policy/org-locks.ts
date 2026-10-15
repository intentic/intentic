import { ORG_SECTIONS, type OrgPolicy, type OrgSection, orgSectionMode } from "../schemas/organisation.js";

// WHICH DAEMON ROUTES AN ORGANISATION'S LOCK COVERS, and the refusal the daemon's middleware hands a request to one of
// them (docs/architecture/organisations.md). Named route by route rather than by contract group: a group mixes the
// changes a lock is about with operations it is not (a probe, a reveal, a sign-in being cancelled, a person confirming
// their own AI-literacy notice), and a lock that broke those would be a lock nobody could live with. A route added
// later is therefore open until it is listed here, which is the failure a reviewer can see in this file's diff.
//
// Names are the contract's own: `group.procedure` for a typed route, `METHOD /path` for a raw one (RAW_ROUTES). The
// test beside this checks every name against the route tables, so a rename cannot leave a lock pointing at nothing.

interface SectionRoutes {
    // Refused while the section is locked or hidden: every change the section's page makes.
    readonly changes: readonly string[];
    // Refused only while it is hidden: reads that put a value in front of a person, which hiding is meant to stop.
    readonly reveals?: readonly string[];
}

export const ORG_SECTION_ROUTES = {
    models: { changes: ["accounts.start", "accounts.complete", "accounts.rename", "accounts.disconnect"] },
    agent: {
        // `privacy.learn` stays open: teaching the shield more values only ever adds protection.
        changes: [
            "settings.set",
            "settings.setAgentDomain",
            "privacy.setPolicy",
            "privacy.forget",
            "safety.setPolicy",
            "skills.save",
            "skills.remove",
        ],
        reveals: ["privacy.reveal"],
    },
    // Rejecting a proposed tool and timing a rebuild stay open: neither changes what the sandbox is made of.
    environment: {
        changes: [
            "POST /environment/approve",
            "POST /environment/runtime-install",
            "POST /environment/remove",
            "POST /engines/channel",
            "POST /engines/update",
            "POST /engines/revert",
        ],
    },
    // Secrets and connections share the Secrets page. Asking a named person to release one (`secrets.request`) stays
    // open: it changes nothing until that person says yes.
    secrets: {
        changes: [
            "secrets.set",
            "secrets.generate",
            "secrets.remove",
            "secrets.setGate",
            "secrets.removeGate",
            "secrets.setHosts",
            "secrets.setPolicy",
            "capabilities.add",
            "capabilities.remove",
            "capabilities.rename",
            "capabilities.setSecret",
            "capabilities.sshKey",
            "capabilities.login",
        ],
        reveals: ["secrets.reveal"],
    },
    "data-protection": { changes: ["compliance.applyPreset"] },
    extensions: {
        changes: [
            "extensions.create",
            "extensions.remove",
            "extensions.setSettings",
            "extensions.approve",
            "extensions.setEnabled",
            "extensions.applyUpdate",
            "extensions.revert",
            "extensions.setUpdatePolicy",
            "extensions.devSet",
            "extensions.devClear",
            "extensions.devReload",
        ],
    },
    // Leaving (`DELETE /members/self`) stays open: nobody can be held in a sandbox by a policy.
    access: { changes: ["POST /members", "DELETE /members"] },
    areas: { changes: ["areas.save", "areas.remove"] },
    personas: { changes: ["personas.save", "personas.remove", "personas.savePrompt", "personas.saveSkill", "personas.removeSkill"] },
    updates: { changes: ["system.autoUpdate", "system.skipUpdate"] },
} as const satisfies Readonly<Record<OrgSection, SectionRoutes>>;

// Route name → the section it belongs to and whether it is a change or a reveal; built once.
type Covered = { readonly section: OrgSection; readonly kind: "change" | "reveal" };
const COVERED: ReadonlyMap<string, Covered> = (() => {
    const covered = new Map<string, Covered>();
    for (const section of ORG_SECTIONS) {
        const routes: SectionRoutes = ORG_SECTION_ROUTES[section];
        for (const name of routes.changes) {
            covered.set(name, { section, kind: "change" });
        }
        for (const name of routes.reveals ?? []) {
            covered.set(name, { section, kind: "reveal" });
        }
    }
    return covered;
})();

// The section a route belongs to, or undefined for one no lock covers.
export const orgSectionOfRoute = (routeName: string): OrgSection | undefined => COVERED.get(routeName)?.section;

export interface OrgLockRefusal {
    readonly error: string;
    readonly reason: "org-locked";
    readonly section: OrgSection;
    readonly org: string;
}

// The refusal for one request, or undefined to let it through. No policy (a personal sandbox) is always undefined:
// this function is the whole of what an organisation changes about a request, and for a personal sandbox it is nothing.
export const orgLockRefusal = (policy: OrgPolicy | undefined, routeName: string | undefined): OrgLockRefusal | undefined => {
    if (policy === undefined || routeName === undefined) {
        return undefined;
    }
    const covered = COVERED.get(routeName);
    if (covered === undefined) {
        return undefined;
    }
    const mode = orgSectionMode(policy, covered.section);
    const refused = covered.kind === "change" ? mode !== "open" : mode === "hidden";
    return refused
        ? {
              error: `${policy.orgName} manages this part of the sandbox (${covered.section}); ask your organisation's admin to change it`,
              reason: "org-locked",
              section: covered.section,
              org: policy.orgName,
          }
        : undefined;
};
