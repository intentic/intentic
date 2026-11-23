<script setup lang="ts">
import { Button, Icon, timeAgo, toneWash, ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import type { AutomationApproval } from "@intentic/sandbox-contract/schemas/automations";
import { computed } from "vue";
import OriginMark from "../../../../parts/fleet/OriginMark.vue";
import { useT } from "@intentic/ui/i18n";
import type { CardFit } from "../view/boardGrid";

// Approvals-queue row drawn on the board, a sibling of an agent card, not one: no conversation exists until Approve is
// pressed.
// Attention lane only, since a hold means only "waiting on you".
// Approve/Reject sit on the card, not behind hover, since releasing it is the whole point; the countdown names the
// auto-run alternative so it doesn't look like the board acted on its own.

// `dense` is the stacked, narrow board, as AgentCard means it: same facts, drawn at the ledger's weight, since a
// stacked board's lanes are told apart by their order rather than by how heavy their cards are.
const t = useT();

// `fit`, the board's room for a card (boardGrid.ts `CardFit`): slim, the title takes its line whole and the rest wraps under
// it; a tile is the pause glyph over its two presses, since releasing the hold is the card's whole point.
const { entry, dense, fit = `full` } = defineProps<{ entry: AutomationApproval; dense?: boolean; fit?: CardFit }>();
const emit = defineEmits<{ approve: []; reject: [] }>();

// First line of what fired: distinguishes two holds of the same automation (which otherwise share no payload).
const snippet = computed(() => entry.payload?.split("\n", 1)[0] ?? undefined);
const slim = computed(() => fit !== `full`);
const title = computed(() => entry.title ?? entry.automationId);

// The shared clock rather than a timer of this card's own, armed only while a countdown shows, and quantized to the
// 5s the label is coarse to: a finer tick would redraw the card for words that had not changed.
const COARSE_MS = 5_000;
const now = useNow(() => entry.autoRunAt !== undefined);
const coarseNow = computed(() => Math.floor(now.value / COARSE_MS) * COARSE_MS);
// Each unit hands over before the number it would print stops being readable at a glance: a hold parked for three days
// read "runs itself in 4320m", which is a number to do arithmetic on rather than a wait to feel.
const autoRunLabel = computed(() => {
    if (entry.autoRunAt === undefined) {
        return undefined;
    }
    const seconds = Math.max(0, Math.round((entry.autoRunAt - coarseNow.value) / 1000));
    if (seconds < 120) {
        return t(`agents.heldWakeCard.runsInSeconds`, { seconds });
    }
    if (seconds < 2 * 3_600) {
        return t(`agents.heldWakeCard.runsInMinutes`, { minutes: Math.round(seconds / 60) });
    }
    return seconds < 2 * 86_400
        ? t(`agents.heldWakeCard.runsInHours`, { hours: Math.round(seconds / 3_600) })
        : t(`agents.heldWakeCard.runsInDays`, { days: Math.round(seconds / 86_400) });
});
</script>

<template>
    <div
        class="group flex w-full select-none flex-col rounded-xl border border-dashed border-line bg-card text-left"
        :class="fit === `tile` ? 'items-center gap-1.5 px-1 py-2' : slim ? 'gap-2 p-3' : dense ? 'gap-2 p-3.5' : 'gap-2.5 p-3.5'"
    >
        <template v-if="fit === `tile`">
            <span
                v-tooltip.right="`${title} · ${t(`agents.heldWakeCard.held`)}`"
                class="flex h-7 w-7 items-center justify-center rounded-full"
                :class="toneWash(`warning`)"
            >
                <Icon name="pause" class="text-xs" />
            </span>
            <button
                type="button"
                :class="ui.iconButton({ tone: `danger` })"
                :aria-label="t(`agents.heldWakeCard.rejectHeldWake`)"
                v-tooltip.right="t(`agents.heldWakeCard.reject`)"
                @click.stop="emit(`reject`)"
            >
                <Icon name="times" class="text-xs" />
            </button>
            <button
                type="button"
                :class="ui.iconButton({}, `text-link`)"
                :aria-label="t(`agents.heldWakeCard.approveHeldWake`)"
                v-tooltip.right="t(`ui.action.approve`)"
                @click.stop="emit(`approve`)"
            >
                <Icon name="check" class="text-xs" />
            </button>
        </template>
        <div v-else class="flex items-center gap-2.5" :class="slim ? 'flex-wrap gap-y-2' : ''">
            <!-- Pause glyph where an agent card has its identity tile: a held wake, not a session, nothing running yet. -->
            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-(length:--ring-track) ring-inset ring-content/12">
                <span class="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full" :class="toneWash(`warning`)">
                    <Icon name="pause" class="text-2xs" />
                </span>
            </span>
            <!-- Holds use the live card's weight outside the Attention lane. -->
            <!-- `break-words` for the reason AgentCard's title states: a clamp only ellipsises a VERTICAL overrun. -->
            <span
                class="min-w-0 flex-1 font-semibold text-content"
                :class="slim ? 'line-clamp-3 basis-[calc(100%-2.375rem)] break-words text-xs leading-snug' : dense ? 'truncate text-xs' : 'line-clamp-2 break-words text-xs leading-snug'"
                >{{ title }}</span
            >
            <span class="ui-status-pill shrink-0 font-semibold" :class="toneWash(`warning`)">{{ t(`agents.heldWakeCard.held`) }}</span>
        </div>
        <div v-if="snippet !== undefined && fit !== `tile` && fit !== `mini`" class="truncate text-2xs text-muted">{{ snippet }}</div>
        <div v-if="fit !== `tile`" class="flex items-center gap-2.5" :class="slim ? 'flex-wrap gap-y-2' : ''">
            <OriginMark :origin="entry.origin" />
            <span class="min-w-0 flex-1 truncate text-2xs text-subtle" :class="slim ? 'basis-full' : ''">
                {{ autoRunLabel ?? t(`agents.heldWakeCard.waiting`) }} · {{ timeAgo(entry.createdAt) }}
            </span>
            <!-- Compact action buttons use a 44px touch target on coarse pointers. -->
            <Button
                size="small"
                tier="quiet"
                tone="danger"
                thumb
                class="shrink-0"
                :class="slim ? 'ml-auto' : ''"
                :aria-label="t(`agents.heldWakeCard.rejectHeldWake`)"
                v-tooltip.top="{ title: t(`agents.heldWakeCard.dropWake`), note: t(`agents.heldWakeCard.automationUnchanged`) }"
                @click.stop="emit(`reject`)"
            >
                {{ t(`agents.heldWakeCard.reject`) }}
            </Button>
            <Button
                tier="accent"
                size="small"
                thumb
                :aria-label="t(`agents.heldWakeCard.approveHeldWake`)"
                v-tooltip.top="{ title: t(`agents.heldWakeCard.runNow`), note: t(`agents.heldWakeCard.landsOnBoard`) }"
                @click.stop="emit(`approve`)"
            >
                {{ t(`ui.action.approve`) }}
            </Button>
        </div>
    </div>
</template>
