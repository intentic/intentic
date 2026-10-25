<!-- Session's identity mark, shared by the fleet board tile, the chat rail tile, and the chat's quick bar so all three stay identical. -->
<script setup lang="ts">
import { computed } from "vue";
import { type SessionFacts, sessionKind, sessionModule } from "../../models/agent-status/sessionKind";

// Undefined for a chat no agent stands behind yet: it reads as the everyday single agent, uncoloured.
const props = defineProps<{ session: SessionFacts | undefined }>();
const kind = computed(() => sessionKind(props.session));
const module = computed(() => sessionModule(props.session));
// Children working right now, on any kind: a home running helpers says so as plainly as an orchestrator.
const running = computed(() => props.session?.subagents?.running ?? 0);
</script>

<template>
    <!-- ROUND, because this mark is worn inside a ring. The glyph is the kind, the wash the package (sessionKind.ts). -->
    <span
        class="relative flex shrink-0 items-center justify-center rounded-full"
        :class="module === undefined ? `bg-content/5 text-muted` : `module-tile`"
        :style="module === undefined ? undefined : { '--tile-hue': module.hue }"
        :data-session-kind="kind.name"
    >
        <Icon v-if="kind.icon !== undefined" :name="kind.icon" aria-hidden="true" />
        <!-- The everyday kind is a dot, not a glyph: a mark on every card would tell none of them apart. -->
        <span v-else class="size-[0.45em] rounded-full bg-current" aria-hidden="true"></span>
        <!-- `ring-canvas` parts the count from the disc it overlaps, as every badge pinned to an avatar does. -->
        <span
            v-if="running > 0"
            class="absolute -right-1.5 -top-1 flex h-3 min-w-3 items-center justify-center rounded-full bg-content px-0.5 text-[0.5625rem] font-bold leading-none text-canvas tabular-nums ring-1 ring-canvas"
            aria-hidden="true"
            data-subagents-badge
            >{{ running }}</span
        >
    </span>
</template>
