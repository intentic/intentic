<!-- THE WAY TO UNINSTALL INTENTIC, at the foot of This device and in its quietest voice: one sentence and one button that
     opens the review (UninstallDialog.vue). Nothing is removed from here; the dialog says what would be, and asks. -->
<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import UninstallDialog from "./UninstallDialog.vue";

const { appVersion } = defineProps<{
    /** The app's own version, for the dialog's ledger when ic does not say. */
    appVersion?: string | undefined;
}>();

const t = useT();
const open = ref(false);
</script>

<template>
    <section class="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl bg-card p-4 shadow-sm">
        <div class="flex min-w-0 flex-1 items-start gap-2.5">
            <Icon name="trash" class="mt-0.5 shrink-0 text-subtle" />
            <div class="min-w-0">
                <h2 class="text-sm leading-tight font-semibold">{{ t(`desktop.uninstall.sectionTitle`) }}</h2>
                <p class="mt-1 max-w-read-sm text-xs leading-relaxed text-muted">{{ t(`desktop.uninstall.sectionLead`) }}</p>
            </div>
        </div>
        <Button size="small" tier="boring" class="shrink-0" :label="t(`desktop.uninstall.open`)" @click="open = true" />
        <UninstallDialog v-model:open="open" :app-version="appVersion" />
    </section>
</template>
