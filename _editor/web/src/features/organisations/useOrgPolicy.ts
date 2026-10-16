import {
    ORG_SECTIONS,
    type OrgPolicy,
    type OrgPolicyState,
    type OrgSection,
    type OrgSectionMode,
    OrgSectionSchema,
    orgSectionMode,
} from "@intentic/sandbox-contract/schemas/organisation";
import { computed } from "vue";
import { rpcQuery } from "../../client/sandbox/rpcQuery";
import { supportsRoute } from "../../client/sandbox/useDaemonRoutes";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";

// The organisation policy the active sandbox's daemon enforces (GET /org/policy; docs/architecture/organisations.md),
// read so the hub draws what the daemon will refuse: a hidden section leaves the index, a locked one is shown
// read-only. Rendering only, never the boundary: the daemon refuses a locked change whatever this says. A personal
// sandbox, or a daemon too old to have the route, reads as unbound, which changes nothing. Too old is known from the
// hello's route list, so such a daemon is never asked (released daemons up to 1.337.0 lack it, and each ask came back
// as an error naming the route).

const isOrgSection = (slug: string): slug is OrgSection => OrgSectionSchema.safeParse(slug).success;

// Hub sections that are no organisation section of their own, by the section whose lock holds them: the one the daemon
// files their writes under (sandbox-contract policy/org-locks.ts). The privacy shield, the judge's policy and every
// setting the three pages write (`settings.set`) are the Agent section's routes, which is where these three pages were
// until 2026-10-16; a lock that let them go when they moved would be one a reader could undo by finding them.
const HELD_WITH: ReadonlyMap<string, OrgSection> = new Map([
    [`privacy-shield`, `agent`],
    [`guardrails`, `agent`],
    [`retention`, `agent`],
]);
const orgSectionOf = (slug: string): OrgSection | undefined => HELD_WITH.get(slug) ?? (isOrgSection(slug) ? slug : undefined);

export function useOrgPolicy() {
    // Unpersisted: a lock read from yesterday's cache would draw a section open, or shut, that no longer is.
    const { query } = useSandboxQuery({
        ...rpcQuery(`org.policy`, undefined, { unpersisted: true }),
        enabled: computed(() => supportsRoute(`org.policy`)),
    });
    const state = computed<OrgPolicyState | undefined>(() => query.data.value);
    const policy = computed<OrgPolicy | undefined>(() => (state.value?.bound === true ? state.value.policy : undefined));
    // A hub slug's mode; a slug no organisation holds (Overview, Usage, Activity, Audit, an extension's view) is always open.
    const modeOf = (slug: string): OrgSectionMode => {
        const section = orgSectionOf(slug);
        return section === undefined ? `open` : orgSectionMode(policy.value, section);
    };
    const hidden = computed<ReadonlySet<string>>(() => {
        const sections = ORG_SECTIONS.filter((section) => orgSectionMode(policy.value, section) === `hidden`);
        const held = [...HELD_WITH].filter(([, section]) => sections.includes(section)).map(([slug]) => slug);
        return new Set<string>([...sections, ...held]);
    });
    return { policy, modeOf, hidden };
}
