<script setup lang="ts">
import { ConfirmDialog, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { CloseQuestion } from "./useCloseGuard";

// The question useCloseGuard.ts asks, in the same words wherever a close would discard unsaved edits: a tab's ×, a bulk
// close from the tab menu, or a local window the app held back.

const props = defineProps<{ open: boolean; question: CloseQuestion | undefined }>();
const emit = defineEmits<{ cancel: []; confirm: [] }>();
const t = useT();

const header = computed(() => {
    const count = props.question?.paths.length ?? 0;
    return count === 1 ? t(`workspace.closeGuard.discardUnsavedChanges`) : t(`workspace.closeGuard.discardUnsavedChangesIn`, { count });
});
const consequence = computed(() => {
    switch (props.question?.what) {
        case `window`:
            return t(`workspace.closeGuard.closingWindowDiscardsUnsaved`);
        case `tabs`:
            return t(`workspace.closeGuard.closingTabsDiscardsUnsaved`);
        default:
            return t(`workspace.closeGuard.closingTabDiscardsUnsaved`);
    }
});
</script>

<template>
    <ConfirmDialog
        :open="props.open"
        :header="header"
        :confirm-label="t(`workspace.closeGuard.closeAnyway`)"
        confirm-icon="times"
        :items="props.question?.paths ?? []"
        @cancel="emit(`cancel`)"
        @confirm="emit(`confirm`)"
    >
        <template #item="{ item }">
            <Icon name="circle-fill" class="shrink-0 text-[0.4rem] text-warning" />
            <span class="truncate text-content">{{ item }}</span>
        </template>
        <p class="mt-3 text-xs text-muted">{{ consequence }}</p>
    </ConfirmDialog>
</template>
