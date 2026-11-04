<!-- A lane's cards on their way: drawn while the board has not heard this sandbox's roster and remembers none, so a
     lane says its sessions are coming rather than holding the drafts alone, which read as every other session gone. -->
<script setup lang="ts">
import { useLoadingReveal } from "@intentic/ui/loading-reveal";
import { computed } from "vue";
import type { FleetLane } from "../../../../models/agent-status/agentStatus-lanes";
import { useSandbox } from "../../../../client/sandbox/useSandbox";

const { lane, dense = false } = defineProps<{ lane: FleetLane; dense?: boolean }>();

// The board's usual shape, not a count this board was ever seen holding: nothing is remembered for this sandbox, or
// its roster would be drawing instead. Attention is mostly short, Finished the longest.
const CARDS = { attention: 1, active: 2, finished: 3 } as const satisfies Record<FleetLane, number>;
const TITLE_WIDTHS = [`w-3/5`, `w-2/5`, `w-1/2`];
const LINE_WIDTHS = [`w-4/5`, `w-full`, `w-3/4`];

// Mounted only while the board waits, so the wait is this component's life: a roster that answers within a moment
// draws no placeholder at all, only lanes that stay empty for it.
const { activeSandboxId } = useSandbox();
const revealed = useLoadingReveal(
    computed(() => true),
    computed(() => activeSandboxId.value ?? ``),
);
</script>

<template>
    <div class="flex flex-col gap-4.5 pb-2.5" aria-hidden="true" :class="revealed ? '' : 'invisible'">
        <div
            v-for="index in CARDS[lane]"
            :key="index"
            class="flex flex-col rounded-2xl border border-line"
            :class="dense || lane === 'finished' ? 'gap-2 p-3.5' : 'gap-2.5 p-4'"
        >
            <span class="skeleton block h-3.5" :class="TITLE_WIDTHS[(index - 1) % TITLE_WIDTHS.length]" />
            <span class="skeleton block h-2.5" :class="LINE_WIDTHS[(index - 1) % LINE_WIDTHS.length]" />
            <span class="skeleton block h-2.5 w-1/4" />
        </div>
    </div>
</template>
