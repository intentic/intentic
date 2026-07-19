<script setup lang="ts">
import { computed } from "vue";
import type { ProgressEvent } from "../desktop";

/* Renders the live progress stream as a stage timeline: one row per stage with its latest log line
 * underneath; a percent event draws a bar (image/rootfs downloads). */
const props = defineProps<{ events: ProgressEvent[] }>();

interface Stage {
    stage: string;
    label: string;
    state: `running` | `done` | `failed`;
    lastMessage?: string;
    percent?: number;
}

const stages = computed<Stage[]>(() => {
    const ordered: Stage[] = [];
    const byStage = new Map<string, Stage>();
    for (const event of props.events) {
        let entry = byStage.get(event.stage);
        if (entry === undefined) {
            entry = { stage: event.stage, label: event.label || event.stage, state: `running` };
            byStage.set(event.stage, entry);
            ordered.push(entry);
        }
        if (event.label) {
            entry.label = event.label;
        }
        if (event.state === `done`) {
            entry.state = `done`;
            entry.percent = undefined;
        } else if (event.state === `failed`) {
            entry.state = `failed`;
        }
        if (event.message) {
            entry.lastMessage = event.message;
        }
        if (event.state === `percent` && event.percent !== null) {
            entry.percent = event.percent;
        }
    }
    return ordered;
});
</script>

<template>
    <ol class="flex flex-col gap-2">
        <li v-for="stage in stages" :key="stage.stage" class="flex items-start gap-3 rounded-xl border border-line bg-canvas px-3 py-2.5">
            <Icon
                :name="stage.state === `done` ? `check-circle` : stage.state === `failed` ? `warning` : `spinner`"
                :spin="stage.state === `running`"
                :class="stage.state === `done` ? `text-success` : stage.state === `failed` ? `text-danger` : `text-info`"
                class="mt-0.5 shrink-0"
            />
            <div class="flex min-w-0 flex-1 flex-col gap-1">
                <span class="text-sm font-medium text-content">{{ stage.label }}</span>
                <div v-if="stage.percent !== undefined" class="h-1.5 w-full overflow-hidden rounded-full bg-surface">
                    <div class="h-full rounded-full bg-primary-500 transition-all" :style="{ width: `${Math.min(stage.percent, 100)}%` }" />
                </div>
                <span v-if="stage.lastMessage" class="truncate font-mono text-2xs text-subtle" :title="stage.lastMessage">
                    {{ stage.lastMessage }}
                </span>
            </div>
        </li>
    </ol>
</template>
