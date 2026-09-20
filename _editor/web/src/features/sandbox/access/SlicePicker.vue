<script setup lang="ts">
import { StatusBadge } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { RouterLink } from "vue-router";
import { useSlices } from "../slices/useSlices";
import { useT } from "@intentic/ui/i18n";

// Which parts of the workspace this person reaches: one switch per slice the sandbox has named. Naming none is the
// whole workspace, which is what every grant means until somebody narrows it — so an all-off picker is a real
// answer, not an unfinished one, and the line under it says which.

const t = useT();

const { picked, disabled = false } = defineProps<{ picked: readonly string[] | undefined; disabled?: boolean }>();
// `undefined` is the whole workspace; a list, even empty, is the grant deciding.
const emit = defineEmits<{ change: [slices: string[] | undefined] }>();

const { slices } = useSlices();

const toggle = (id: string, on: boolean): void => {
    const held = picked ?? [];
    const next = on ? [...new Set([...held, id])] : held.filter((slice) => slice !== id);
    // Switching the last one off gives the workspace back rather than fencing them to nothing: nobody presses a
    // toggle meaning to end up seeing no files at all, and "no fence" is the state this page started in.
    emit(`change`, next.length === 0 ? undefined : next);
};
</script>

<template>
    <div class="flex flex-col gap-2">
        <span class="text-xs text-subtle">{{ t(`sandbox.sandboxAccess.slicePick`) }}</span>
        <p v-if="slices.length === 0" class="text-xs text-subtle">
            {{ t(`sandbox.sandboxAccess.noSlicesToGrant`) }}
            <RouterLink to="/sandbox/slices" class="underline">{{ t(`sandbox.sandboxAccess.nameOne`) }}</RouterLink>
        </p>
        <label v-for="slice in slices" :key="slice.id" class="flex items-center justify-between gap-3">
            <span class="flex min-w-0 flex-col">
                <span class="flex min-w-0 items-baseline gap-1.5">
                    <span class="truncate text-sm text-content">{{ slice.label ?? slice.id }}</span>
                    <StatusBadge variant="neutral" size="xs">{{ slice.folders.join(`, `) }}</StatusBadge>
                </span>
                <span v-if="slice.brief !== undefined" class="truncate text-2xs text-subtle">{{ slice.brief }}</span>
            </span>
            <ToggleSwitch
                :model-value="(picked ?? []).includes(slice.id)"
                :disabled="disabled"
                @update:model-value="(on: boolean) => toggle(slice.id, on)"
            />
        </label>
        <span v-if="slices.length > 0 && picked === undefined" class="text-2xs text-subtle">{{ t(`sandbox.sandboxAccess.noSliceMeansWhole`) }}</span>
    </div>
</template>
