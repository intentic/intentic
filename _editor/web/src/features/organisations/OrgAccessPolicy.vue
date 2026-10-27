<script setup lang="ts">
import { computed, ref, toRaw } from "vue";
import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { OrgCeiling } from "@intentic/sandbox-contract/schemas/organisation";
import { Button, Icon, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { idFromName } from "../../lib/idFromName";
import OrgPolicyList from "./OrgPolicyList.vue";
import OrgToolCeiling from "./OrgToolCeiling.vue";
const profiles = defineModel<AccessProfile[]>("profiles");
const ceiling = defineModel<OrgCeiling>("ceiling");
defineProps<{ readonly?: boolean }>();
const t = useT();
const tools = computed({
    get: () => ceiling.value?.tools ?? {},
    set: (value) => {
        ceiling.value = { ...ceiling.value, tools: value };
    },
});
const accounts = computed({
    get: () => ceiling.value?.aiAccounts,
    set: (value) => {
        ceiling.value = { ...ceiling.value, aiAccounts: value };
    },
});
const opened = ref<number>();
// A profile is named, never given an id: one added in this edit takes its id from its name as it is typed, and one the
// policy already carried keeps the id every bound sandbox's people and services point at, whatever it is renamed to.
// Held by the plain object, since the model hands each entry back wrapped in its reactive proxy.
const fresh = new WeakSet<AccessProfile>();
const add = (): void => {
    opened.value = 0;
    const profile: AccessProfile = { id: idFromName(``, profiles.value?.map((entry) => entry.id) ?? [], `profile`) };
    fresh.add(profile);
    profiles.value = [profile, ...(profiles.value ?? [])];
};
const rename = (profile: AccessProfile, label: string): void => {
    profile.label = label === `` ? undefined : label;
    if (fresh.has(toRaw(profile))) {
        const others = (profiles.value ?? []).filter((entry) => entry !== profile).map((entry) => entry.id);
        profile.id = idFromName(label, others, `profile`);
    }
};
const shelves = (profile: AccessProfile) =>
    computed({
        get: () => profile.tools ?? {},
        set: (value) => {
            profile.tools = value;
        },
    });
</script>
<template>
    <!-- One box stating the gap, so whatever mounts this does not decide how the two groups sit apart. -->
    <div class="flex flex-col gap-6">
        <RowGroup :label="t(`organisations.accessPolicy.profiles`)">
            <template v-if="!readonly" #actions>
                <Button :label="t(`organisations.accessPolicy.add`)" size="small" tier="boring" :disabled="(profiles?.length ?? 0) >= 50" @click="add"
                    ><template #icon><Icon name="plus" /></template
                ></Button>
            </template>
            <RowNote>{{ t(`organisations.accessPolicy.profileNote`) }}</RowNote>
            <RowNote v-if="!profiles?.length">{{ t(`organisations.accessPolicy.empty`) }}</RowNote>
            <!-- A block at the group's own tier, so each profile's form sits on the rows' surface rather than off it. -->
            <RowNote v-for="(profile, index) in profiles" :key="index" variant="block">
                <details :open="index === opened">
                    <summary class="cursor-pointer text-sm font-medium">{{ profile.label || t(`organisations.accessPolicy.unnamed`) }}</summary>
                    <div class="mt-3 flex flex-col gap-2">
                        <label class="flex flex-col gap-1 text-xs text-subtle">
                            {{ t(`organisations.accessPolicy.label`) }}
                            <input
                                :value="profile.label ?? ``"
                                :readonly="readonly"
                                maxlength="60"
                                :class="ui.input({ size: `sm` })"
                                @input="rename(profile, ($event.target as HTMLInputElement).value)"
                            />
                        </label>
                        <Row :title="t(`organisations.accessPolicy.agents`)"
                            ><template #control>
                                <select
                                    v-model="profile.agents"
                                    :disabled="readonly"
                                    :aria-label="t(`organisations.accessPolicy.agents`)"
                                    :class="ui.input({ size: `sm` })"
                                >
                                    <option :value="undefined">{{ t(`organisations.accessPolicy.defaultRun`) }}</option>
                                    <option v-for="mode in [`off`, `chat`, `run`, `home`] as const" :key="mode" :value="mode">
                                        {{ t(`organisations.accessPolicy.${mode}`) }}
                                    </option>
                                </select>
                            </template></Row
                        >
                        <OrgToolCeiling v-model="shelves(profile).value" :readonly="readonly" />
                        <OrgPolicyList
                            v-model="profile.aiAccounts"
                            :label="t(`organisations.accessPolicy.aiAccounts`)"
                            :note="t(`organisations.accessPolicy.accountNote`)"
                            :readonly="readonly"
                        />
                        <RowNote>{{ t(`organisations.accessPolicy.localNote`) }}</RowNote>
                        <OrgPolicyList v-model="profile.areas" :label="t(`organisations.accessPolicy.areas`)" :readonly="readonly" />
                        <Row :title="t(`organisations.accessPolicy.credentials`)">
                            <template #control
                                ><ToggleSwitch
                                    :model-value="profile.credentials !== undefined"
                                    :disabled="readonly"
                                    :aria-label="t(`organisations.accessPolicy.credentials`)"
                                    @update:model-value="profile.credentials = $event ? { capabilities: [], secrets: [] } : undefined"
                            /></template>
                        </Row>
                        <template v-if="profile.credentials">
                            <OrgPolicyList
                                :model-value="profile.credentials.capabilities"
                                @update:model-value="profile.credentials.capabilities = $event ?? []"
                                :label="t(`organisations.accessPolicy.capabilities`)"
                                :readonly="readonly"
                                required
                            />
                            <OrgPolicyList
                                :model-value="profile.credentials.secrets"
                                @update:model-value="profile.credentials.secrets = $event ?? []"
                                :label="t(`organisations.accessPolicy.secrets`)"
                                :readonly="readonly"
                                required
                            />
                        </template>
                        <OrgPolicyList v-model="profile.assistants" :label="t(`organisations.accessPolicy.assistants`)" :readonly="readonly" />
                        <Button
                            v-if="!readonly"
                            :label="t(`ui.action.remove`)"
                            size="small"
                            tier="quiet"
                            tone="danger"
                            @click="profiles = profiles?.filter((_, i) => i !== index)"
                        />
                    </div>
                </details>
            </RowNote>
        </RowGroup>
        <RowGroup :label="t(`organisations.accessPolicy.ceiling`)">
            <RowNote>{{ t(`organisations.accessPolicy.ceilingNote`) }}</RowNote>
            <OrgToolCeiling v-model="tools" :readonly="readonly" />
            <OrgPolicyList
                v-model="accounts"
                :label="t(`organisations.accessPolicy.aiAccounts`)"
                :note="t(`organisations.accessPolicy.accountNote`)"
                :readonly="readonly"
            />
        </RowGroup>
    </div>
</template>
