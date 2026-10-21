<script setup lang="ts">
import { Icon, ui } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { RunLine } from "./runLine";

// A stage or commit run, in the press bar's one reading line (runLine.ts decides it): a flex item of the bar that grows
// into the line's room and is never taller than a press. `pressed` is the panel saying its own press is spinning for this
// run: the press already shows the wait, so the line drops its spinner and starts on the field's edge, words only. One
// spinner per wait, never two side by side.
const { line, pressed = false } = defineProps<{ line: RunLine; pressed?: boolean }>();

// The bar's quiet icon press, the same size as the panel's other icon buttons, so Stop never reads as a second commit.
const STOP_BUTTON = ui.iconButton(`shrink-0`);
</script>

<template>
    <span class="flex min-w-0 flex-1 basis-28 items-center gap-1.5 text-2xs text-muted" aria-live="polite">
        <!-- The panels' leading-glyph slot (ReviewPanel's LEAD), so a stage run's spinner shares the rows' chevron column. -->
        <span v-if="!pressed" class="flex w-2.5 shrink-0 items-center justify-center"><Icon name="spinner" spin /></span>
        <span class="min-w-0 truncate whitespace-nowrap" v-tooltip.right="line.tip">{{ line.words }}</span>
        <span v-if="line.others > 0" class="shrink-0 tabular-nums text-subtle">{{
            t(`workspace.indexRunPrompt.andMore`, { count: line.others })
        }}</span>
        <span v-if="line.lostContact" class="shrink-0 text-warning">{{ t(`workspace.indexRunPrompt.reconnecting`) }}</span>
        <button
            v-if="line.stuck"
            type="button"
            :class="STOP_BUTTON"
            :aria-label="t(`workspace.indexRunPrompt.stop`)"
            v-tooltip.top="t(`workspace.indexRunPrompt.stop`)"
            @click="line.stop"
        >
            <Icon name="stop" class="text-2xs" />
        </button>
    </span>
</template>
