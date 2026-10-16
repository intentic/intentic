<script setup lang="ts">
import type { OrgDetail, OrgRole } from "@intentic/api-contract";
import {
    ORG_SECTIONS,
    type OrgPolicyRules,
    type OrgSectionMode,
    orgPinnedGroups,
    orgSectionMode,
} from "@intentic/sandbox-contract/schemas/organisation";
import { PRESET_GROUPS, type PresetGroup } from "@intentic/sandbox-contract/schemas/compliance";
import { Button, Notice, Row, RowGroup, RowNote, SegmentedControl, ui } from "@intentic/ui";
import { formatDateTime } from "@intentic/ui/format";
import ToggleSwitch from "primevue/toggleswitch";
import { type NoticeModel, noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, shallowRef } from "vue";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { apiClient } from "../../lib/useApi";

// One organisation as its console shows it: the policy, section by section; who is in it; which sandboxes it holds.
// An admin edits all three; a member reads the policy their sandboxes are held to and nothing about anyone else, which
// is also all the platform answers them (OrgDetailSchema).

const { org } = defineProps<{ org: OrgDetail }>();
const emit = defineEmits<{ changed: [detail: OrgDetail] }>();

const t = useT();
const { sandboxes } = useSandbox();
const admin = computed(() => org.role === `admin`);
const notice = shallowRef<NoticeModel>();
const busy = ref(false);

// Every change goes through here: one at a time, its answer handed up, its failure shown here.
const act = async (change: () => Promise<OrgDetail>, failure: string): Promise<void> => {
    if (busy.value) {
        return;
    }
    busy.value = true;
    try {
        emit(`changed`, await change());
        notice.value = undefined;
    } catch (error) {
        notice.value = noticeFrom(error, failure);
    } finally {
        busy.value = false;
    }
};

// THE POLICY, edited as a draft and saved as one new edition: how each section is held, which groups of the
// public-office preset every sandbox is pinned to (the daemon holds them on what it reads, whatever its files say), and
// whether only the organisation's people may be given access (removing someone then removes them everywhere).
const draft = ref(ORG_SECTIONS.map((section) => ({ section, mode: orgSectionMode(org.policy, section) })));
const pins = ref(PRESET_GROUPS.map((group) => ({ group, pinned: orgPinnedGroups(org.policy).includes(group) })));
const membersOnly = ref(org.policy.membersOnly === true);
const MODES: readonly OrgSectionMode[] = [`open`, `locked`, `hidden`];
const modeOptions = computed(() => MODES.map((mode) => ({ value: mode, label: t(`organisations.mode.${mode}`) })));
const dirty = computed(
    () =>
        draft.value.some((row) => row.mode !== orgSectionMode(org.policy, row.section)) ||
        pins.value.some((row) => row.pinned !== orgPinnedGroups(org.policy).includes(row.group)) ||
        membersOnly.value !== (org.policy.membersOnly === true),
);
const savePolicy = (): Promise<void> => {
    // Only what is not open is written: a section the policy leaves out is open, so the stored rules stay short. The same
    // for pins and the member fence: absent is none.
    const sections: OrgPolicyRules[`sections`] = Object.fromEntries(draft.value.filter((row) => row.mode !== `open`).map((row) => [row.section, row.mode]));
    const preset: PresetGroup[] = pins.value.filter((row) => row.pinned).map((row) => row.group);
    const rules = { sections, ...(preset.length > 0 && { preset }), ...(membersOnly.value && { membersOnly: true }) };
    return act(() => apiClient.org.setPolicy({ orgId: org.id, rules, expectedVersion: org.policyVersion }), t(`organisations.detail.couldntSave`));
};

// THE PEOPLE.
const email = ref(``);
const role = ref<OrgRole>(`member`);
const roleOptions = computed(() => ([`member`, `admin`] as const).map((value) => ({ value, label: t(`organisations.role.${value}`) })));
const addMember = (): Promise<void> =>
    act(async () => {
        const added = await apiClient.org.addMember({ orgId: org.id, email: email.value.trim(), role: role.value });
        email.value = ``;
        return added;
    }, t(`organisations.detail.couldntAdd`));
const removeMember = (address: string): Promise<void> =>
    act(() => apiClient.org.removeMember({ orgId: org.id, email: address }), t(`organisations.detail.couldntRemove`));

// THE SANDBOXES. An admin binds one they own; a sandbox already here, or someone else's, is not offered.
const bindable = computed(() => sandboxes.value.filter((sandbox) => sandbox.role === `owner` && !(org.sandboxes ?? []).some((bound) => bound.id === sandbox.id)));
const toBind = ref(``);
const bind = (): Promise<void> =>
    toBind.value === ``
        ? Promise.resolve()
        : act(() => apiClient.org.bindSandbox({ orgId: org.id, sandboxId: toBind.value }), t(`organisations.detail.couldntBind`));
const unbind = (sandboxId: string): Promise<void> =>
    act(() => apiClient.org.unbindSandbox({ orgId: org.id, sandboxId }), t(`organisations.detail.couldntUnbind`));
// Whether a sandbox's daemon has said it holds the current edition; one that never asked is waiting too. A daemon that
// once came back holding less than it had (its copy deleted, broken or restored) says when, as evidence for the admin.
const applied = (held: number | undefined): string =>
    held === org.policyVersion ? t(`organisations.detail.applied`, { version: held }) : t(`organisations.detail.pending`, { version: org.policyVersion });
const sandboxLine = (sandbox: NonNullable<OrgDetail[`sandboxes`]>[number]): string =>
    [
        sandbox.ownerEmail,
        applied(sandbox.policyApplied),
        ...(sandbox.policyResetAt === undefined ? [] : [t(`organisations.detail.policyReset`, { date: formatDateTime(Date.parse(sandbox.policyResetAt)) })]),
    ].join(` · `);
</script>

<template>
    <div class="flex flex-col gap-6">
        <Notice v-if="notice" :of="notice" />

        <RowGroup :label="t(`organisations.detail.policy`, { version: org.policyVersion })">
            <RowNote>{{ t(`organisations.detail.policyNote`) }}</RowNote>
            <Row v-for="row in draft" :key="row.section" :title="t(`organisations.section.${row.section}`)">
                <template #control>
                    <SegmentedControl v-if="admin" v-model="row.mode" :options="modeOptions" :aria-label="t(`organisations.section.${row.section}`)" size="xs" />
                    <span v-else class="text-xs text-subtle">{{ t(`organisations.mode.${row.mode}`) }}</span>
                </template>
            </Row>
        </RowGroup>

        <RowGroup :label="t(`organisations.preset.group`)">
            <RowNote>{{ t(`organisations.preset.note`) }}</RowNote>
            <Row v-for="row in pins" :key="row.group" :title="t(`organisations.preset.${row.group}`)">
                <template #control>
                    <ToggleSwitch v-if="admin" v-model="row.pinned" :aria-label="t(`organisations.preset.${row.group}`)" />
                    <span v-else class="text-xs text-subtle">{{ row.pinned ? t(`organisations.preset.pinned`) : t(`organisations.preset.notPinned`) }}</span>
                </template>
            </Row>
            <Row :title="t(`organisations.detail.membersOnly`)" :description="t(`organisations.detail.membersOnlyNote`)">
                <template #control>
                    <ToggleSwitch v-if="admin" v-model="membersOnly" :aria-label="t(`organisations.detail.membersOnly`)" />
                    <span v-else class="text-xs text-subtle">{{ membersOnly ? t(`organisations.preset.pinned`) : t(`organisations.preset.notPinned`) }}</span>
                </template>
            </Row>
            <RowNote v-if="admin" variant="block">
                <Button :label="t(`organisations.detail.savePolicy`)" size="small" :disabled="!dirty || busy" :loading="busy" @click="savePolicy" />
            </RowNote>
        </RowGroup>

        <RowGroup v-if="admin" :label="t(`organisations.detail.members`)">
            <Row v-for="member in org.members ?? []" :key="member.email" icon="user" :title="member.email" :description="t(`organisations.role.${member.role}`)">
                <template #control>
                    <Button :label="t(`ui.action.remove`)" size="small" tier="quiet" tone="danger" :disabled="busy" @click="removeMember(member.email)" />
                </template>
            </Row>
            <RowNote variant="block">
                <form class="flex flex-wrap items-center gap-2" @submit.prevent="addMember">
                    <input
                        v-model="email"
                        type="email"
                        autocomplete="off"
                        :placeholder="t(`organisations.detail.emailPlaceholder`)"
                        :aria-label="t(`organisations.detail.emailPlaceholder`)"
                        :class="ui.input({ size: `sm` }, `min-w-48 flex-1`)"
                    />
                    <SegmentedControl v-model="role" :options="roleOptions" :aria-label="t(`organisations.detail.members`)" size="xs" />
                    <Button type="submit" :label="t(`organisations.detail.add`)" size="small" :disabled="busy || email.trim() === ``" />
                </form>
            </RowNote>
        </RowGroup>

        <RowGroup v-if="admin" :label="t(`organisations.detail.sandboxes`)">
            <Row
                v-for="sandbox in org.sandboxes ?? []"
                :key="sandbox.id"
                icon="box"
                :title="sandbox.name"
                :description="sandboxLine(sandbox)"
            >
                <template #control>
                    <Button :label="t(`organisations.detail.unbind`)" size="small" tier="quiet" :disabled="busy" @click="unbind(sandbox.id)" />
                </template>
            </Row>
            <RowNote v-if="(org.sandboxes ?? []).length === 0">{{ t(`organisations.detail.noSandboxes`) }}</RowNote>
            <RowNote v-if="bindable.length > 0" variant="block">
                <form class="flex flex-wrap items-center gap-2" @submit.prevent="bind">
                    <select v-model="toBind" :aria-label="t(`organisations.detail.pickSandbox`)" :class="ui.input({ size: `sm` }, `min-w-48 flex-1`)">
                        <option value="" disabled>{{ t(`organisations.detail.pickSandbox`) }}</option>
                        <option v-for="sandbox in bindable" :key="sandbox.id" :value="sandbox.id">{{ sandbox.name }}</option>
                    </select>
                    <Button type="submit" :label="t(`organisations.detail.bind`)" size="small" :disabled="busy || toBind === ``" />
                </form>
                <p class="mt-2 text-2xs text-subtle">{{ t(`organisations.detail.bindNote`) }}</p>
            </RowNote>
        </RowGroup>
    </div>
</template>
