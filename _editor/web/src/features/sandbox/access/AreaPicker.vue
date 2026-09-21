<script setup lang="ts">
import type { GrantedRole } from "@intentic/sandbox-contract";
import { StatusBadge } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useAreas } from "../areas/useAreas";
import { usePersonaReach } from "./usePersonaReach";
import { useT } from "@intentic/ui/i18n";

// Which parts of the workspace this person reaches: one switch per area the sandbox has named. Naming none is the
// whole workspace, which is what every grant means until somebody narrows it — so an all-off picker is a real
// answer, not an unfinished one, and the line under it says which.
// The fence is also the only thing deciding which assistants they may talk to, so the line under the switches names
// them: this is the one control whose consequence is not readable off the control itself.

const t = useT();

// The tier decides what this picker owes: a writer and a desk cannot be granted unfenced, and a desk's fence has to
// reach an assistant, since that is the whole of what a desk reaches.
const { picked, role, disabled = false } = defineProps<{ picked: readonly string[] | undefined; role: GrantedRole; disabled?: boolean }>();
// `undefined` is the whole workspace; a list, even empty, is the grant deciding.
const emit = defineEmits<{ change: [areas: string[] | undefined] }>();

const { areas } = useAreas();
const { namesOf } = usePersonaReach();

const held = computed<readonly string[]>(() => picked ?? []);
const reached = computed<string[]>(() => namesOf(picked));
const needsOne = computed(() => role === `writer` || role === `desk`);
// A desk reaches its assistants and nothing else, so a fence that holds none is a grant with nothing behind it.
const strandsDesk = computed(() => role === `desk` && held.value.length > 0 && reached.value.length === 0);

const toggle = (id: string, on: boolean): void => {
    const next = on ? [...new Set([...held.value, id])] : held.value.filter((area) => area !== id);
    // Switching the last one off gives the workspace back rather than fencing them to nothing: nobody presses a
    // toggle meaning to end up seeing no files at all, and "no fence" is the state this page started in.
    emit(`change`, next.length === 0 ? undefined : next);
};
</script>

<template>
    <div class="flex flex-col gap-2">
        <span class="text-xs text-subtle">{{ t(`sandbox.sandboxAccess.areaPick`) }}</span>
        <p v-if="areas.length === 0" class="text-xs text-subtle">
            {{ t(`sandbox.sandboxAccess.noAreasToGrant`) }}
            <RouterLink to="/sandbox/areas" class="underline">{{ t(`sandbox.sandboxAccess.nameOne`) }}</RouterLink>
        </p>
        <label v-for="area in areas" :key="area.id" class="flex items-center justify-between gap-3">
            <span class="flex min-w-0 flex-col">
                <span class="flex min-w-0 items-baseline gap-1.5">
                    <span class="truncate text-sm text-content">{{ area.label ?? area.id }}</span>
                    <StatusBadge variant="neutral" size="xs">{{ area.folders.join(`, `) }}</StatusBadge>
                </span>
                <span v-if="area.brief !== undefined" class="truncate text-2xs text-subtle">{{ area.brief }}</span>
            </span>
            <ToggleSwitch :model-value="held.includes(area.id)" :disabled="disabled" @update:model-value="(on: boolean) => toggle(area.id, on)" />
        </label>

        <!-- What the fence above hands over, in assistants. The refusals first: a tier that cannot be granted this way
             says so before it says what the pick would mean. -->
        <template v-if="areas.length > 0">
            <span v-if="needsOne && held.length === 0" class="ui-field-error">{{
                role === `desk` ? t(`sandbox.sandboxAccess.deskNeedsArea`) : t(`sandbox.sandboxAccess.writerNeedsArea`)
            }}</span>
            <span v-else-if="strandsDesk" class="ui-field-error">{{ t(`sandbox.sandboxAccess.noAssistantWorksHere`) }}</span>
            <span v-else-if="picked === undefined" class="text-2xs text-subtle">{{ t(`sandbox.sandboxAccess.noAreaMeansWhole`) }}</span>
            <span v-else-if="reached.length === 0" class="text-2xs text-subtle">{{ t(`sandbox.sandboxAccess.fenceHoldsNoAssistant`) }}</span>
            <span v-else class="text-2xs text-subtle">{{ t(`sandbox.sandboxAccess.fenceHoldsAssistants`, { names: reached.join(`, `) }) }}</span>
        </template>
    </div>
</template>
