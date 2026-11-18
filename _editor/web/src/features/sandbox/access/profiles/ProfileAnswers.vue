<script setup lang="ts">
import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { AgentAccess } from "@intentic/sandbox-contract/schemas/members";
import { RoleFace, Section, SegmentedControl } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ToggleSwitch from "primevue/toggleswitch";
import AreaPicker from "../AreaPicker.vue";
import EditPicker from "../EditPicker.vue";
import ReachPicker from "../ReachPicker.vue";
import AiAccountsPicker from "../ai-accounts/AiAccountsPicker.vue";
import MultiPick from "../pick/MultiPick.vue";
import { useRoleReach } from "../useRoleReach";
import { useRoles } from "../../../../models/sandbox/roles/useRoles";
import ToolCeilingPicker from "./ToolCeilingPicker.vue";
const { profile, disabled = false } = defineProps<{ profile: AccessProfile; disabled?: boolean }>();
const emit = defineEmits<{ change: [profile: AccessProfile] }>();
const t = useT();
const { reach } = useRoleReach();
const set = (change: Partial<AccessProfile>): void => emit(`change`, { ...profile, ...change });
const agents = computed(() =>
    ([`off`, `chat`, `run`, `home`] as const).map((value) => ({ value, label: t(`sandbox.accessProfiles.agents_${value}`) })),
);
const pickAgents = (value: AgentAccess): void =>
    set({
        agents: value,
        ...(value === `chat` || value === `home` ? { edit: undefined } : {}),
        ...(value === `chat` ? { areas: profile.areas ?? [] } : {}),
    });
const pickAreas = (areas: string[] | undefined): void => {
    const edit = profile.edit;
    set({
        areas,
        edit: areas === undefined || edit === undefined ? edit : edit === `all` ? areas : edit.filter((id) => areas.includes(id)),
        assistants: profile.assistants?.filter((id) => reach(areas).some((role) => role.id === id)),
    });
};
const assistantSections = computed(() => [
    { key: `assistants`, entries: reach(profile.areas).map((role) => ({ value: role.id, label: role.label ?? role.id })) },
]);
// The role cards it holds: a conversation wearing one reaches no more than this profile, whoever it works for. A card is
// listed here rather than pointing here itself, since the card sits in the workspace where a conversation could edit it.
const { roles } = useRoles();
const roleSections = computed(() => [
    { key: `roles`, entries: roles.value.map((role) => ({ value: role.id, label: role.label ?? role.id })) },
]);
const modes = computed(() => [
    { value: `all`, label: t(`sandbox.accessProfiles.allAssistants`) },
    { value: `some`, label: t(`sandbox.sandboxAccess.reachSome`) },
]);
</script>
<template>
    <fieldset :disabled="disabled" class="flex min-w-0 flex-col gap-5 border-0 p-0" :class="{ 'pointer-events-none': disabled }">
        <Section :label="t(`sandbox.sandboxAccess.agentsSection`)"
            ><SegmentedControl :model-value="profile.agents ?? `run`" :options="agents" @update:model-value="pickAgents"
        /></Section>
        <label v-if="profile.agents === `home`" class="flex items-center gap-3 text-sm"
            ><ToggleSwitch :model-value="profile.lands === true" @update:model-value="set({ lands: $event })" />{{
                t(`sandbox.sandboxAccess.homeLands`)
            }}</label
        >
        <Section :label="t(`sandbox.sandboxAccess.seeSection`)"
            ><AreaPicker :picked="profile.areas" :chat="profile.agents === `chat`" :disabled="disabled" @change="pickAreas"
        /></Section>
        <Section v-if="profile.agents !== `chat` && profile.agents !== `home`" :label="t(`sandbox.sandboxAccess.editSection`)"
            ><EditPicker
                :edit="profile.edit ?? `none`"
                :see="profile.areas"
                :disabled="disabled"
                @change="set({ edit: $event === `none` ? undefined : $event })"
        /></Section>
        <Section :label="t(`sandbox.sandboxAccess.reachSection`)"
            ><ReachPicker
                :reach="profile.credentials ?? `all`"
                :disabled="disabled"
                @change="set({ credentials: $event === `all` ? undefined : $event })"
        /></Section>
        <Section :label="t(`sandbox.sandboxAccess.aiAccountsSection`)"
            ><AiAccountsPicker
                :accounts="profile.aiAccounts ?? `all`"
                :disabled="disabled"
                @change="set({ aiAccounts: $event === `all` ? undefined : [...$event] })"
        /></Section>
        <Section :label="t(`sandbox.accessProfiles.tools`)"
            ><ToolCeilingPicker :tools="profile.tools" :disabled="disabled" @change="set({ tools: $event })"
        /></Section>
        <Section :label="t(`sandbox.accessProfiles.roles`)">
            <p class="m-0 text-xs text-subtle">{{ t(`sandbox.accessProfiles.rolesHint`) }}</p>
            <MultiPick
                :sections="roleSections"
                :picked="profile.roles ?? []"
                :disabled="disabled"
                :aria-label="t(`sandbox.accessProfiles.roles`)"
                :search-label="t(`sandbox.accessProfiles.roles`)"
                @change="set({ roles: $event.length === 0 ? undefined : $event })"
                ><template #mark="{ value, size }"
                    ><RoleFace :role="roles.find((role) => role.id === value) ?? { id: value }" :size="size" /></template
            ></MultiPick>
        </Section>
        <Section v-if="profile.agents === `chat`" :label="t(`sandbox.accessProfiles.assistants`)">
            <SegmentedControl
                :model-value="profile.assistants === undefined ? `all` : `some`"
                :options="modes"
                @update:model-value="set({ assistants: $event === `all` ? undefined : [] })"
            />
            <MultiPick
                v-if="profile.assistants !== undefined"
                :sections="assistantSections"
                :picked="profile.assistants"
                :disabled="disabled"
                :aria-label="t(`sandbox.accessProfiles.assistants`)"
                :search-label="t(`sandbox.accessProfiles.assistants`)"
                @change="set({ assistants: $event })"
                ><template #mark="{ value, size }"
                    ><RoleFace :role="reach(profile.areas).find((role) => role.id === value) ?? { id: value }" :size="size" /></template
            ></MultiPick>
        </Section>
    </fieldset>
</template>
