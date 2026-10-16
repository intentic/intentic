import { ORG_SECTIONS, type OrgPolicy, type OrgPolicyState, type OrgSection, type OrgSectionMode, OrgSectionSchema, orgSectionMode } from "@intentic/sandbox-contract";
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

export function useOrgPolicy() {
    // Unpersisted: a lock read from yesterday's cache would draw a section open, or shut, that no longer is.
    const { query } = useSandboxQuery({
        ...rpcQuery(`org.policy`, undefined, { unpersisted: true }),
        enabled: computed(() => supportsRoute(`org.policy`)),
    });
    const state = computed<OrgPolicyState | undefined>(() => query.data.value);
    const policy = computed<OrgPolicy | undefined>(() => (state.value?.bound === true ? state.value.policy : undefined));
    // A hub slug's mode; a slug no organisation holds (Overview, Usage, Audit, an extension's view) is always open.
    const modeOf = (slug: string): OrgSectionMode => (isOrgSection(slug) ? orgSectionMode(policy.value, slug) : `open`);
    const hidden = computed<ReadonlySet<string>>(() => new Set(ORG_SECTIONS.filter((section) => orgSectionMode(policy.value, section) === `hidden`)));
    return { policy, modeOf, hidden };
}
