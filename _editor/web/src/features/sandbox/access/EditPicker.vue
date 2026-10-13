<script setup lang="ts">
import { SegmentedControl } from "@intentic/ui";
import Checkbox from "primevue/checkbox";
import { computed } from "vue";
import { useAreas } from "../areas/useAreas";
import { useT } from "@intentic/ui/i18n";

// WHERE ONE PERSON MAY CHANGE FILES BY HAND, inside what they may see: nowhere, everything they see, or the areas ticked.
// Only the areas they see are offered, and "everything" only when they see the whole workspace, so the picker cannot
// make an answer the daemon would refuse. Their agents' changes are a separate matter: those land when somebody who
// manages the sandbox lands them.

const t = useT();

const {
    edit,
    see,
    disabled = false,
} = defineProps<{ edit: `none` | `all` | readonly string[]; see: readonly string[] | undefined; disabled?: boolean }>();
const emit = defineEmits<{ change: [edit: `none` | `all` | string[]] }>();

const { areas } = useAreas();
// The areas an edit may name: every area when they see the whole workspace, else the ones they see.
const editable = computed(() => (see === undefined ? areas.value : areas.value.filter((area) => see.includes(area.id))));

type Scope = `none` | `all` | `some`;
const scope = computed<Scope>(() => (edit === `none` || edit === `all` ? edit : `some`));
const held = computed<readonly string[]>(() => (edit === `none` || edit === `all` ? [] : edit));
const SCOPES = computed(() => [
    { value: `none` as const, label: t(`sandbox.sandboxAccess.editNothing`) },
    ...(see === undefined ? [{ value: `all` as const, label: t(`sandbox.sandboxAccess.editEverything`) }] : []),
    ...(editable.value.length > 0 ? [{ value: `some` as const, label: t(`sandbox.sandboxAccess.onlySomeAreas`) }] : []),
]);
const pickScope = (next: Scope): void => emit(`change`, next === `some` ? [...held.value] : next);
const toggle = (id: string, on: boolean): void => {
    emit(`change`, on ? [...new Set([...held.value, id])] : held.value.filter((area) => area !== id));
};
</script>

<template>
    <div class="flex flex-col gap-2.5">
        <SegmentedControl :model-value="scope" :options="SCOPES" :class="{ 'pointer-events-none opacity-60': disabled }" @update:model-value="pickScope" />
        <div v-if="scope === `some`" class="-mx-2.5 flex flex-col gap-0.5" role="group" :aria-label="t(`sandbox.sandboxAccess.editSection`)">
            <label
                v-for="area in editable"
                :key="area.id"
                class="ui-row-select flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5"
                :class="{ 'ui-row-select-on': held.includes(area.id), 'pointer-events-none opacity-60': disabled }"
            >
                <Checkbox
                    :model-value="held.includes(area.id)"
                    binary
                    size="small"
                    :disabled="disabled"
                    @update:model-value="(on: unknown) => toggle(area.id, on === true)"
                />
                <span class="flex min-w-0 flex-1 items-baseline gap-2">
                    <span class="text-sm text-content">{{ area.label ?? area.id }}</span>
                    <span class="truncate font-mono text-2xs text-subtle">{{ area.folders.join(`, `) }}</span>
                </span>
            </label>
        </div>
        <p class="text-xs text-muted">{{ t(`sandbox.sandboxAccess.editNote`) }}</p>
    </div>
</template>
