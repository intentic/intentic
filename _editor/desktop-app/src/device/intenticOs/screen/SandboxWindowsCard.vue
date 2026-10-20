<script setup lang="ts">
import { Notice } from "@intentic/ui";
import { usePoll } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, inject, onMounted, ref } from "vue";
import type { OsScreenStatus } from "../../../osSettings";
import { onScreen } from "../../../onScreen";
import { sandboxes } from "../../machine";
import { SCREEN_ACTIONS, screenActions, windowRowsOf } from "./sandboxWindows";

// SANDBOX WINDOWS, on This computer when it runs Intentic OS with a screen (sandboxWindows.ts): a switch for each of
// this computer's sandboxes, off until the owner turns it on, that lets it open windows of its own on this screen.

const t = useT();
const screen = inject(SCREEN_ACTIONS, screenActions);
const status = ref<OsScreenStatus>();
// The sandbox whose switch is being changed: one at a time, and its switch holds still meanwhile.
const changing = ref<string>();
const problem = ref<`readFailure` | `changeFailure`>();

/** Sandboxes start and stop from elsewhere (the workspace, an agent), so the list is read again while on screen. */
const READ_EVERY_MS = 10_000;

const read = async (): Promise<void> => {
    try {
        status.value = (await screen.status()) ?? undefined;
        if (problem.value === `readFailure`) {
            problem.value = undefined;
        }
    } catch {
        problem.value = `readFailure`;
    }
};
const reading = usePoll({ everyMs: READ_EVERY_MS, visible: onScreen, check: read });
onMounted(() => reading.start());

const rows = computed(() => (status.value === undefined ? [] : windowRowsOf(status.value, sandboxes.value)));

const flip = async (slug: string, allowed: boolean): Promise<void> => {
    if (changing.value !== undefined) {
        return;
    }
    changing.value = slug;
    problem.value = undefined;
    try {
        status.value = (await screen.allow(slug, allowed)) ?? undefined;
    } catch {
        problem.value = `changeFailure`;
    } finally {
        changing.value = undefined;
    }
};
</script>

<template>
    <section v-if="status" class="flex flex-col gap-3 rounded-xl border border-line p-4" :aria-busy="changing !== undefined">
        <header class="flex items-start gap-2.5 text-sm">
            <Icon name="desktop" class="shrink-0 text-subtle" />
            <div class="min-w-0 flex-1">
                <h2 class="text-sm leading-tight font-semibold">{{ t(`desktop.os.windows.title`) }}</h2>
                <p class="mt-1 text-xs text-muted">{{ t(`desktop.os.windows.lead`) }}</p>
            </div>
        </header>
        <Notice v-if="problem" tone="warning" class="text-xs">{{ t(`desktop.os.windows.${problem}`) }}</Notice>
        <p v-if="!status.available && rows.some((row) => row.allowed)" class="text-xs text-muted">{{ t(`desktop.os.windows.paused`) }}</p>
        <p v-if="rows.length === 0" class="text-xs text-muted">{{ t(`desktop.os.windows.none`) }}</p>
        <ul v-else class="flex flex-col gap-2">
            <li v-for="row in rows" :key="row.slug" class="flex items-center gap-3">
                <div class="min-w-0 flex-1">
                    <p class="truncate text-sm">{{ row.name }}</p>
                    <p class="text-2xs text-subtle">{{ t(row.drawing ? `desktop.os.windows.drawing` : row.allowed ? `desktop.os.windows.allowed` : `desktop.os.windows.off`) }}</p>
                </div>
                <ToggleSwitch
                    :model-value="row.allowed"
                    :disabled="changing !== undefined"
                    :aria-label="t(`desktop.os.windows.switch`, { name: row.name })"
                    class="ui-switch-sm shrink-0"
                    @update:model-value="(on: boolean) => flip(row.slug, on)"
                />
            </li>
        </ul>
    </section>
</template>
