<script setup lang="ts">
import { StatusBadge } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { RouterLink } from "vue-router";
import { useAreas } from "../areas/useAreas";
import { useT } from "@intentic/ui/i18n";

// Which parts of the workspace this person reaches: one switch per area the sandbox has named. Naming none is the
// whole workspace, which is what every grant means until somebody narrows it — so an all-off picker is a real
// answer, not an unfinished one, and the line under it says which.

const t = useT();

// `needsOne` is the writer tier asking: there, naming no area is not the whole workspace but a grant the daemon
// refuses, so the picker has to say what the row is still waiting for rather than read as finished.
const {
    picked,
    disabled = false,
    needsOne = false,
} = defineProps<{ picked: readonly string[] | undefined; disabled?: boolean; needsOne?: boolean }>();
// `undefined` is the whole workspace; a list, even empty, is the grant deciding.
const emit = defineEmits<{ change: [areas: string[] | undefined] }>();

const { areas } = useAreas();

const toggle = (id: string, on: boolean): void => {
    const held = picked ?? [];
    const next = on ? [...new Set([...held, id])] : held.filter((area) => area !== id);
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
            <ToggleSwitch
                :model-value="(picked ?? []).includes(area.id)"
                :disabled="disabled"
                @update:model-value="(on: boolean) => toggle(area.id, on)"
            />
        </label>
        <span v-if="needsOne && (picked ?? []).length === 0 && areas.length > 0" class="ui-field-error">{{
            t(`sandbox.sandboxAccess.writerNeedsArea`)
        }}</span>
        <span v-else-if="areas.length > 0 && picked === undefined" class="text-2xs text-subtle">{{
            t(`sandbox.sandboxAccess.noAreaMeansWhole`)
        }}</span>
    </div>
</template>
