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
const LINE_WIDTHS = [`w-24`, `w-16`, `w-20`];

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
        <!-- AgentCard's own surface and spacing (a live lane's roomier card, the ledger's tighter one), its corner row of ring,
             title and standing, then the model line: the card that lands keeps its place and its lines where these were. -->
        <div
            v-for="index in CARDS[lane]"
            :key="index"
            class="session-card pointer-events-none flex w-full flex-col rounded-2xl border p-3.5"
            :class="lane === 'finished' ? 'gap-2' : 'gap-2.5'"
        >
            <div class="flex items-center gap-x-2.5">
                <span class="skeleton block size-5.5 shrink-0 self-start rounded-full" />
                <span class="flex min-w-0 flex-1 flex-col text-xs leading-snug">
                    <span class="flex h-[1lh] items-center"><span class="skeleton block h-3" :class="TITLE_WIDTHS[(index - 1) % TITLE_WIDTHS.length]" /></span>
                </span>
                <span class="skeleton block h-2.5 w-8 shrink-0 self-start" />
            </div>
            <div :class="dense ? 'flex flex-wrap items-center gap-x-3.5 gap-y-1.5' : 'flex flex-col gap-2'">
                <div class="flex h-4 min-w-0 items-center gap-x-3">
                    <span class="skeleton block h-2 w-20" />
                    <span class="skeleton block h-2 w-14" />
                    <span v-if="!dense" class="skeleton block h-2" :class="LINE_WIDTHS[(index - 1) % LINE_WIDTHS.length]" />
                </div>
            </div>
        </div>
    </div>
</template>
