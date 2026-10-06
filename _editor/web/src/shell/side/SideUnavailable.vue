<script setup lang="ts">
import { EmptyState } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

// A tab whose side view is not registered: an extension that was switched off or removed since the tab was opened, or
// one still loading after a reload. Says so in place, so the tab can be read and closed rather than vanishing.
const t = useT();
</script>

<template>
    <EmptyState icon="extensions" :title="t(`shell.sidePanel.unavailable`)" :line="t(`shell.sidePanel.unavailableNote`)" class="flex-1" />
</template>
