<!-- Session's identity mark, shared by the fleet board tile, the chat rail tile, and the chat's quick bar so all three stay identical. -->
<script setup lang="ts">
import { computed } from "vue";
import { tonePlate, toneWash } from "@intentic/ui";
import { type SessionFacts, contextPressure, sessionKind } from "../../models/agent-status/sessionKind";

// Undefined for a chat no agent stands behind yet: it reads as the everyday single agent, uncoloured.
const props = defineProps<{ session: SessionFacts | undefined }>();
const kind = computed(() => sessionKind(props.session));
// An amber wash and an amber mark as the context window fills, a solid amber plate once it is nearly spent (contextPressure).
// The wash alone vanishes on an 18px disc, so while filling the mark inside carries the colour: the kind's glyph, or for
// the everyday kind, which otherwise draws nothing, a dot.
const pressure = computed(() => contextPressure(props.session));
const fill = computed(() => {
    const level = pressure.value;
    return level === `full` ? tonePlate(`warning`) : level === `filling` ? toneWash(`warning`) : `bg-content/5 text-muted`;
});
// Children working right now, on any kind: a home running helpers says so as plainly as an orchestrator.
const running = computed(() => props.session?.subagents?.running ?? 0);
</script>

<template>
    <!-- ROUND, because this mark is worn inside a ring. The glyph is the kind, the wash how full its context is (sessionKind.ts). -->
    <span
        class="relative flex shrink-0 items-center justify-center rounded-full"
        :class="fill"
        :data-context-pressure="pressure"
        :data-session-kind="kind.name"
    >
        <!-- The everyday kind draws nothing inside the disc: a mark on every card would tell none of them apart. -->
        <Icon v-if="kind.icon !== undefined" :name="kind.icon" aria-hidden="true" />
        <span v-else-if="pressure === `filling`" class="size-[0.45em] rounded-full bg-current" aria-hidden="true"></span>
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
