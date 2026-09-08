<script setup lang="ts">
import { Button, Icon, timeAgo } from "@intentic/ui";
import type { AutomationApproval } from "@intentic/sandbox-contract";
import { computed, onMounted, onUnmounted, ref } from "vue";
import OriginMark from "../../../components/OriginMark.vue";

// Approvals-queue row drawn on the board, a sibling of an agent card, not one: no conversation exists until Approve is
// pressed.
// Attention lane only, since a hold means only "waiting on you".
// Approve/Reject sit on the card, not behind hover, since releasing it is the whole point; the countdown names the
// auto-run alternative so it doesn't look like the board acted on its own.

// `dense` is the stacked, narrow board, as AgentCard means it: same facts, drawn at the ledger's weight, since a
// stacked board's lanes are told apart by their order rather than by how heavy their cards are.
const { entry, dense } = defineProps<{ entry: AutomationApproval; busy?: boolean; dense?: boolean }>();
const emit = defineEmits<{ approve: []; reject: [] }>();

// First line of what fired: distinguishes two holds of the same automation (which otherwise share no payload).
const snippet = computed(() => entry.payload?.split("\n", 1)[0] ?? undefined);

// Coarse 5s clock, only while a countdown shows: the label only needs to say "this will run itself", not the exact
// second.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
    if (entry.autoRunAt !== undefined) {
        ticker = setInterval(() => (now.value = Date.now()), 5_000);
    }
});
onUnmounted(() => clearInterval(ticker));
const autoRunLabel = computed(() => {
    if (entry.autoRunAt === undefined) {
        return undefined;
    }
    const seconds = Math.max(0, Math.round((entry.autoRunAt - now.value) / 1000));
    return seconds >= 120 ? `runs itself in ${Math.round(seconds / 60)}m` : `runs itself in ${seconds}s`;
});
</script>

<template>
    <div
        class="group flex w-full select-none flex-col rounded-xl border border-dashed border-line bg-card text-left"
        :class="[dense ? 'gap-2 p-3.5' : 'gap-2.5 p-4', busy ? 'pointer-events-none opacity-60' : '']"
    >
        <div class="flex items-center gap-2.5">
            <!--
                Pause glyph where an agent card has its identity tile: a held wake, not a session, nothing running
                yet. Two boxes for the same reason the workflow run's mark has two — a 22px disc centred in the 28px
                slot the agent tile's context ring occupies (AgentCard argues the proportion), so the titles in this
                lane start on one axis and every mark in the lane is the same shape and size.
                It wears the empty rim for that reason too: a bare disc beside a ringed card reads a size smaller.
            -->
            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-[1.5px] ring-inset ring-content/12">
                <span class="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full bg-warning/15">
                    <Icon name="pause" class="text-2xs text-warning" />
                </span>
            </span>
            <!-- A hold only ever sits in Attention, so off the stacked board it is always drawn at the live card's weight (AgentCard's `live`). -->
            <!-- `break-words` for the reason AgentCard's title states: a clamp only ellipsises a VERTICAL overrun, and an
                 automation id is exactly the unbreakable run that overruns sideways instead. -->
            <span
                class="min-w-0 flex-1 font-semibold text-content"
                :class="dense ? 'truncate text-xs' : 'line-clamp-2 break-words text-sm leading-snug'"
                >{{ entry.title ?? entry.automationId }}</span
            >
            <span class="shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-2xs font-semibold text-warning">held</span>
        </div>
        <div v-if="snippet !== undefined" class="truncate text-2xs text-muted">{{ snippet }}</div>
        <div class="flex items-center gap-2.5">
            <OriginMark :origin="entry.origin" />
            <span class="min-w-0 flex-1 truncate text-2xs text-subtle">
                {{ autoRunLabel ?? `waiting for you` }} · {{ timeAgo(entry.createdAt) }}
            </span>
            <!--
                Visually small (22px) buttons deciding what an agent may do; `touch-target` grows the tappable area to
                44px on a coarse pointer without changing the visual size.
                The row's gap keeps the two enlarged tap targets from overlapping, since a mis-tap here runs an
                automation.
            -->
            <Button
                size="small"
                severity="danger"
                :text="true"
                class="shrink-0"
                aria-label="Reject this held wake"
                v-tooltip.top="`Drop it: the wake never runs, the automation stays as it is`"
                @click.stop="emit(`reject`)"
            >
                Reject
            </Button>
            <Button
                size="small"
                class="shrink-0"
                aria-label="Approve this held wake"
                v-tooltip.top="`Run it now, with exactly what fired: the session lands on this board`"
                @click.stop="emit(`approve`)"
            >
                Approve
            </Button>
        </div>
    </div>
</template>
