<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";

// A tab whose side view is not registered: an extension that was switched off or removed since the tab was opened, or
// one still loading after a reload. Says so in place, so the tab can be read and closed rather than vanishing.
const t = useT();
</script>

<template>
    <div class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <Icon name="extensions" class="text-2xl text-subtle" />
        <p class="text-sm text-muted">{{ t(`shell.sidePanel.unavailable`) }}</p>
        <p class="max-w-xs text-2xs text-subtle">{{ t(`shell.sidePanel.unavailableNote`) }}</p>
    </div>
</template>
