<script setup lang="ts">
import type { HostedWaitView } from "./hostedWait";

// A healthy wait on a machine of ours: one row per step, the current one spinning, and the note under them that carries
// the origin's estimate and the time waited. A failed wait says its problem instead, which is the caller's to draw
// (Setup.vue offers a start-over beside it). Shared by /setup's card and the Add sandbox dialog.

const { wait } = defineProps<{ wait: Pick<HostedWaitView, `steps` | `note`> }>();
</script>

<template>
    <ul class="flex flex-col gap-1.5">
        <li
            v-for="step in wait.steps"
            :key="step.key"
            class="flex items-center gap-2 text-xs"
            :class="step.state === `todo` ? `text-subtle` : `text-content`"
        >
            <Icon
                :name="step.state === `done` ? `check` : step.state === `active` ? `spinner` : `circle`"
                :spin="step.state === `active`"
                class="shrink-0 text-xs"
                :class="step.state === `done` ? `text-success` : step.state === `active` ? `text-info` : `text-subtle`"
            />
            <span>{{ step.label }}</span>
        </li>
    </ul>
    <p class="text-xs text-muted">{{ wait.note }}</p>
</template>
