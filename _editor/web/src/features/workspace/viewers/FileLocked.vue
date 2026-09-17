<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { lockedFile } from "./lockedFile";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* The refusal used to arrive as a flicker: a tab appeared, the read came back empty, the tab closed. */

const { path } = defineProps<{ path: string }>();

const locked = computed(() => lockedFile(path));
</script>

<template>
    <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Icon name="lock" class="text-4xl text-subtle" />
        <p class="text-sm text-content">
            <span class="font-medium">{{ locked.subject }}</span> {{ t(`workspace.fileLocked.keptPrivateBySandbox`) }}
        </p>
        <p class="max-w-sm text-xs text-muted">{{ t(`workspace.fileLocked.holdsCantOpenedEdited`, { holds: locked.holds }) }}</p>
        <RouterLink
            v-if="locked.manage"
            :to="locked.manage.to"
            class="mt-1 inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-xs text-content transition-colors hover:border-line-strong hover:bg-overlay"
        >
            {{ t(`ui.action.open`) }} {{ locked.manage.label }}
            <Icon name="arrow-right" class="text-xs" />
        </RouterLink>
    </div>
</template>
