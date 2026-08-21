<script setup lang="ts">
import { Icon, timeAgo } from "@intentic/ui";
import type { AutomationApproval } from "@intentic/sandbox-contract";
import { computed, onMounted, onUnmounted, ref } from "vue";
import OriginMark from "../components/OriginMark.vue";

/* A WAKE HELD AT THE DOOR: the approvals queue's row, drawn on the board. Like the workflow run it is an
 * agent card's SIBLING, not an agent card: there is no conversation yet, no branch, no transcript, the
 * session this row describes exists only if you press Approve. That is also why it lives in the Attention
 * lane and nowhere else: a hold's entire meaning is "waiting on you".
 *
 * Approve and Reject are on the card and not behind a hover, for the Stop button's reason: releasing a held
 * wake is the one thing a person comes to this row to do. The countdown names the other way out: a
 * `holdForSeconds` hold runs itself once the deadline passes on a quiet fleet, and a row that auto-runs
 * without ever saying so reads as the board acting on its own. */

const { entry } = defineProps<{ entry: AutomationApproval; busy?: boolean }>();
const emit = defineEmits<{ approve: []; reject: [] }>();

// The first line of what fired, as the card's body: the only thing that tells two holds of one automation
// apart. A schedule hold has no payload; the automation id is then the whole story.
const snippet = computed(() => entry.payload?.split("\n", 1)[0] ?? undefined);

// A coarse clock (5s), only while a countdown is actually showing: the label's point is "this will run
// itself", not the exact second, and a row without a deadline pays for no timer.
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
        class="group flex w-full select-none flex-col gap-1.5 rounded-lg border border-dashed border-line bg-card p-3 text-left"
        :class="busy ? 'pointer-events-none opacity-60' : ''"
    >
        <div class="flex items-center gap-2">
            <!-- The pause glyph where an agent card carries its identity tile: this row is a held wake, not a
                 session: nothing is running behind it. -->
            <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-warning/15">
                <Icon name="pause" class="text-2xs text-warning" />
            </span>
            <span class="min-w-0 flex-1 truncate text-xs font-semibold text-content">{{ entry.title ?? entry.automationId }}</span>
            <span class="shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-2xs font-semibold text-warning">held</span>
        </div>
        <div v-if="snippet !== undefined" class="truncate text-2xs text-muted">{{ snippet }}</div>
        <div class="flex items-center gap-2">
            <OriginMark :origin="entry.origin" />
            <span class="min-w-0 flex-1 truncate text-2xs text-subtle">
                {{ autoRunLabel ?? `waiting for you` }} · {{ timeAgo(entry.createdAt) }}
            </span>
            <!-- TWO DECISIONS ABOUT WHAT AN AGENT IS ALLOWED TO DO, side by side, and they were the smallest
                 pair of buttons on the board: 22px tall, which is under the WCAG 2.2 floor and a long way
                 under a thumb. `touch-target` grows the tappable box to 44px on a coarse pointer without
                 touching the pill, so the card keeps its density on a desk. `gap-2` on the row is what keeps
                 the two overlays from meeting in the middle: a mis-tap here runs an automation. -->
            <button
                type="button"
                aria-label="Reject this held wake"
                v-tooltip.top="`Drop it: the wake never runs, the automation stays as it is`"
                class="touch-target shrink-0 rounded px-1.5 py-0.5 text-2xs font-semibold text-subtle transition-colors hover:bg-danger/10 hover:text-danger"
                @click.stop="emit(`reject`)"
            >
                Reject
            </button>
            <button
                type="button"
                aria-label="Approve this held wake"
                v-tooltip.top="`Run it now, with exactly what fired: the session lands on this board`"
                class="touch-target shrink-0 rounded bg-primary-600/15 px-1.5 py-0.5 text-2xs font-semibold text-link transition-colors hover:bg-primary-600/25"
                @click.stop="emit(`approve`)"
            >
                Approve
            </button>
        </div>
    </div>
</template>
