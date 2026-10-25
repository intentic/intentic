<!-- The label over a session card's title: what the work is about (the naming pass's topic) and the package it is in,
     in the package's hue, so it reads as one mark with the identity tile beside it. Shared by the board's card and the
     chat rail's, which must name a session alike. Draws nothing for a session with neither. -->
<script setup lang="ts">
import { computed } from "vue";
import { type SessionFacts, sessionModule } from "../../models/agent-status/sessionKind";

const props = defineProps<{ session: SessionFacts | undefined }>();
const module = computed(() => sessionModule(props.session));
const topic = computed(() => props.session?.titleTopic);
// The package's whole name, and the others its changes reach, for the hover; the line itself has room for one.
const moduleHint = computed(() =>
    module.value === undefined ? undefined : [module.value.name, ...(props.session?.modules?.slice(1) ?? [])].join(` · `),
);
</script>

<template>
    <span
        v-if="topic !== undefined || module !== undefined"
        class="flex min-w-0 items-baseline gap-1 text-2xs font-semibold leading-tight"
        :class="module === undefined ? `text-subtle` : `module-ink`"
        :style="module === undefined ? undefined : { '--tile-hue': module.hue }"
        data-session-topic
    >
        <span v-if="topic !== undefined" class="min-w-0 truncate">{{ topic }}</span>
        <span v-if="module !== undefined" v-tooltip.top="moduleHint" class="shrink-0 font-medium opacity-65"
            ><template v-if="topic !== undefined">· </template>{{ module.label }}<template v-if="module.more > 0"> +{{ module.more }}</template></span
        >
    </span>
</template>
