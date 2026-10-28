<!-- A run that is up with a window and no page: a game, a desktop app. Nothing to frame here, so it names each window its
     programs opened on the sandbox desktop and opens it there, as the Browsers view's own window tab. -->
<script setup lang="ts">
import { Button, EmptyState } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useRole } from "../../client/sandbox/useRole";
import { showTab } from "../../workbench/browsers/browsersSurface";

const { label, windows } = defineProps<{
    label: string;
    windows: readonly { readonly id: string; readonly title: string }[];
}>();

const t = useT();
// The desktop is a maintainer's to drive (the daemon refuses the rest), so only they are offered a window on it.
const { canShip } = useRole();
</script>

<template>
    <EmptyState icon="window-maximize" :line="t(`preview.previewPanel.onDesktopLine`)" class="flex-1">
        <template #title>
            <i18n-t keypath="preview.previewPanel.onDesktop" scope="global">
                <template #label
                    ><span class="font-mono">{{ label }}</span></template
                >
            </i18n-t>
        </template>
        <ul class="flex w-full max-w-md flex-col gap-1">
            <li
                v-for="window in windows"
                :key="window.id"
                class="flex items-center justify-between gap-3 rounded-md border border-line px-2.5 py-1.5 text-left"
            >
                <span class="min-w-0 truncate text-2xs text-subtle">{{ window.title || window.id }}</span>
                <Button
                    v-if="canShip"
                    :label="t(`preview.previewPanel.showWindow`)"
                    size="small"
                    tier="boring"
                    @click="showTab({ kind: `app`, id: window.id })"
                />
            </li>
        </ul>
    </EmptyState>
</template>
