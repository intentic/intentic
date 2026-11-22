<!-- THE NEW SANDBOX'S TILE on Home's rail (newSandbox.ts): after the sandboxes, worn like them, from the press on (the
     dialog holds a press still in flight), and on a sandbox's rail at the head of what runs meanwhile (RailProcesses.vue).
     A run that counts itself fills a bar along the tile's foot (newSandboxGauge.ts); one that cannot say wears the rail's
     spinning mark in the bottom corner, as any tile with work behind it does; a run waiting on the reader, or one that
     stopped, wears a mark in the top corner. The hover says the step it is on and the time left. A press shows its page
     in the chat's place, or the dialog again for a press the platform refused. -->
<script setup lang="ts">
import type { ViewBadge } from "@intentic/extension-api";
import { SandboxLogo } from "@intentic/ui";
import type { TipRow } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import TileMark from "../../../components/TileMark.vue";
import { ADD_SANDBOX_HOME_PATH } from "../../../models/sandbox/addSandbox";
import ViewBadgeChip from "../../../workbench/views/ViewBadgeChip.vue";
import { RUNNING_MARK_CLASS } from "../../../workbench/views/viewBadge";
import { newSandbox, newSandboxPageShown, newSandboxShownBy, newSandboxTileShown, readNewSandbox } from "./newSandbox";

const t = useT();
const route = useRoute();
const router = useRouter();
const reading = computed(() => readNewSandbox(newSandbox.value));
const standing = computed(() => newSandboxTileShown(route, newSandbox.value));
const shown = computed(() => newSandboxPageShown(route, newSandbox.value));
const name = computed(() => (reading.value?.name === `` || reading.value === undefined ? t(`home.newSandbox.title`) : reading.value.name));
const label = computed(() => `${name.value} · ${reading.value?.note ?? ``}`);
const corner = computed((): ViewBadge | undefined => {
    switch (reading.value?.phase) {
        case `asking`:
            return { mark: `exclamation-circle`, tone: `warning` };
        case `failed`:
            return { mark: `exclamation-circle`, tone: `danger` };
        default:
            return undefined;
    }
});
const turning = computed(() => reading.value?.phase === `running` || reading.value?.phase === `opening`);
// The bar, while it runs and counts itself; the spinning mark stands in where it cannot say.
const share = computed(() => (reading.value?.phase === `running` ? reading.value.gauge?.share : undefined));
const rows = computed((): TipRow[] => {
    const gauge = reading.value?.gauge;
    if (gauge === undefined || reading.value?.phase !== `running`) {
        return [];
    }
    return [
        ...(gauge.step === undefined ? [] : [{ label: t(`home.newSandbox.tile.now`), value: gauge.step }]),
        ...(gauge.remaining === undefined ? [] : [{ label: t(`home.newSandbox.tile.left`), value: gauge.remaining }]),
    ];
});
// Pushed, so the browser's Back returns to the chat the reader came from.
const show = (): void => {
    if (!newSandboxShownBy(route)) {
        void router.push(ADD_SANDBOX_HOME_PATH);
    }
};
</script>

<template>
    <button
        v-if="reading && standing"
        type="button"
        class="icon-rail-tile ui-row-select ui-row-select-horizontal relative flex items-center justify-center rounded-lg"
        :class="{ 'ui-row-select-on': shown }"
        :aria-label="label"
        :aria-current="shown ? 'true' : undefined"
        v-tooltip.right="{ title: name, note: reading.note, rows }"
        data-new-sandbox-tile
        :data-phase="reading.phase"
        @click="show"
    >
        <span class="icon-rail-picture pointer-events-none flex items-center justify-center overflow-hidden rounded-md">
            <SandboxLogo :image="null" :name="name" class="rounded-md" />
        </span>
        <ViewBadgeChip :badge="corner" class="icon-rail-mark absolute right-0.5 top-0.5" />
        <span
            v-if="share !== undefined"
            class="pointer-events-none absolute inset-x-1.5 bottom-1 h-1 overflow-hidden rounded-full bg-content/15"
            aria-hidden="true"
            data-new-sandbox-bar
        >
            <span class="block h-full rounded-full bg-link transition-[width] duration-500 ease-out" :style="{ width: `${Math.max(share * 100, 6)}%` }"></span>
        </span>
        <TileMark v-else-if="turning" name="spinner" spin :class="[RUNNING_MARK_CLASS, `icon-rail-mark absolute bottom-0.5 right-0.5`]" />
    </button>
</template>
