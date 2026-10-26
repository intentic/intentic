<script setup lang="ts">
import { SegmentedControl, type Tip } from "@intentic/ui";
import { computed } from "vue";
import { useAreas } from "../areas/useAreas";
import MultiPick from "./pick/MultiPick.vue";
import type { PickSection } from "./pick/multiPick";
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
// What each scope means rides on it as a hover card, rather than as a line under the control.
const tip = (title: string): Tip => ({ title, note: t(`sandbox.sandboxAccess.tipEditNote`) });
const SCOPES = computed(() => [
    { value: `none` as const, label: t(`sandbox.sandboxAccess.editNothing`), title: tip(t(`sandbox.sandboxAccess.tipEditNoneTitle`)) },
    ...(see === undefined
        ? [{ value: `all` as const, label: t(`sandbox.sandboxAccess.editEverything`), title: tip(t(`sandbox.sandboxAccess.tipEditAllTitle`)) }]
        : []),
    ...(editable.value.length > 0
        ? [{ value: `some` as const, label: t(`sandbox.sandboxAccess.onlySomeAreas`), title: tip(t(`sandbox.sandboxAccess.tipPickedAreas`)) }]
        : []),
]);
const pickScope = (next: Scope): void => emit(`change`, next === `some` ? [...held.value] : next);
const sections = computed<PickSection[]>(() => [
    { key: `areas`, entries: editable.value.map((area) => ({ value: area.id, label: area.label ?? area.id, detail: area.folders.join(`, `) })) },
]);
</script>

<template>
    <div class="flex flex-col gap-2.5">
        <SegmentedControl :model-value="scope" :options="SCOPES" :class="{ 'pointer-events-none opacity-60': disabled }" @update:model-value="pickScope" />
        <MultiPick
            v-if="scope === `some`"
            :sections="sections"
            :picked="held"
            :search-label="t(`sandbox.sandboxAccess.areaSearch`)"
            :aria-label="t(`sandbox.sandboxAccess.editSection`)"
            :disabled="disabled"
            @change="(next) => emit(`change`, next)"
        />
    </div>
</template>
