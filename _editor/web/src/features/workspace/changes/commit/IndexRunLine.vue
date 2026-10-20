<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { RunLine } from "./runLine";

// A stage or commit run, in the press bar's one reading line (runLine.ts decides it): a flex item of the bar that grows
// into the line's room and is never taller than a press.
const { line } = defineProps<{ line: RunLine }>();
</script>

<template>
    <span class="flex min-w-0 flex-1 basis-28 items-center gap-1.5 text-2xs text-muted" aria-live="polite">
        <Icon name="spinner" spin class="shrink-0" />
        <span class="min-w-0 truncate whitespace-nowrap" v-tooltip.right="line.tip">{{ line.words }}</span>
        <span v-if="line.others > 0" class="shrink-0 tabular-nums text-subtle">{{
            t(`workspace.indexRunPrompt.andMore`, { count: line.others })
        }}</span>
        <span v-if="line.lostContact" class="shrink-0 text-warning">{{ t(`workspace.indexRunPrompt.reconnecting`) }}</span>
        <Button v-if="line.slow" size="small" class="ml-auto shrink-0" @click="line.stop">{{ t(`workspace.indexRunPrompt.stop`) }}</Button>
    </span>
</template>
