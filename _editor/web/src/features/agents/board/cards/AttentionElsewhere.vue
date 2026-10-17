<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { setProjectScope } from "../../../../app/projectScope";

// The tile counts the sandbox and the board shows the open project: what needs the reader outside it is said at the
// head of the Attention lane, with the way to see it (widening the project choice to every project).
defineProps<{ readonly count: number }>();
const t = useT();
</script>

<template>
    <p class="flex items-center gap-2 px-1 pb-2.5 text-2xs text-muted">
        <span>{{ t(`agents.agentsView.needYouElsewhere`, { count }, count) }}</span>
        <span aria-hidden="true">·</span>
        <button type="button" class="font-medium text-link underline-offset-2 hover:underline" @click="setProjectScope(undefined)">
            {{ t(`agents.agentsView.showThem`) }}
        </button>
    </p>
</template>
