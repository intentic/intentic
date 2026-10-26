import type { OrgDetail } from "@intentic/api-contract";
import { PRESET_GROUPS } from "@intentic/sandbox-contract/schemas/compliance";
import { ORG_SECTIONS, type OrgPolicyRules, orgPinnedGroups, orgSectionMode } from "@intentic/sandbox-contract/schemas/organisation";
import { computed, ref, shallowRef, watch } from "vue";

// A policy draft belongs to the edition it was edited from. Member and sandbox changes also return OrgDetail, so
// their newer edition must never be paired with controls still showing an older policy: that bypasses the platform's
// conflict check. Clean controls follow new answers; unsaved edits retain their original edition until saved.
export const useOrgPolicyDraft = (org: () => OrgDetail) => {
    const base = shallowRef(org());
    const draft = ref(ORG_SECTIONS.map((section) => ({ section, mode: orgSectionMode(base.value.policy, section) })));
    const pins = ref(PRESET_GROUPS.map((group) => ({ group, pinned: orgPinnedGroups(base.value.policy).includes(group) })));
    const membersOnly = ref(base.value.policy.membersOnly === true);
    const copy = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
    const profiles = ref<OrgPolicyRules[`profiles`]>(copy(base.value.policy.profiles));
    const ceiling = ref<OrgPolicyRules[`ceiling`]>(copy(base.value.policy.ceiling));
    const dirty = computed(
        () =>
            draft.value.some((row) => row.mode !== orgSectionMode(base.value.policy, row.section)) ||
            pins.value.some((row) => row.pinned !== orgPinnedGroups(base.value.policy).includes(row.group)) ||
            membersOnly.value !== (base.value.policy.membersOnly === true) ||
            JSON.stringify(profiles.value) !== JSON.stringify(base.value.policy.profiles) ||
            JSON.stringify(ceiling.value) !== JSON.stringify(base.value.policy.ceiling),
    );
    const rules = computed(() => {
        const sections: OrgPolicyRules[`sections`] = Object.fromEntries(
            draft.value.filter((row) => row.mode !== `open`).map((row) => [row.section, row.mode]),
        );
        const preset = pins.value.filter((row) => row.pinned).map((row) => row.group);
        return {
            ...(profiles.value !== undefined && { profiles: profiles.value }),
            ...(ceiling.value !== undefined && { ceiling: ceiling.value }),
            sections,
            ...(preset.length > 0 && { preset }),
            ...(membersOnly.value && { membersOnly: true }),
        };
    });
    const accept = (detail: OrgDetail): void => {
        base.value = detail;
        draft.value = ORG_SECTIONS.map((section) => ({ section, mode: orgSectionMode(detail.policy, section) }));
        pins.value = PRESET_GROUPS.map((group) => ({ group, pinned: orgPinnedGroups(detail.policy).includes(group) }));
        membersOnly.value = detail.policy.membersOnly === true;
        profiles.value = copy(detail.policy.profiles);
        ceiling.value = copy(detail.policy.ceiling);
    };
    watch(org, (detail) => {
        if (!dirty.value) {
            accept(detail);
        }
    });
    return { profiles, ceiling, draft, pins, membersOnly, dirty, rules, expectedVersion: computed(() => base.value.policyVersion), accept };
};
