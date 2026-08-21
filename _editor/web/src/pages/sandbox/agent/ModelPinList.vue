<script setup lang="ts">
import { namesThinking } from "@intentic/sandbox-contract";
import type { DescribedPin } from "../../../composables/chat/modelPins";
import ProviderLogo from "../../../chat/ProviderLogo.vue";

/* AN ORDERED LIST OF PINNED MODELS, numbered in the order they will be tried: the body of both rows in
 * Sandbox ▸ Agent ▸ Models.
 *
 * It is a component rather than two copies because the second row grew a list, and the parts a copy gets subtly
 * wrong are the parts that matter: the greyed row for an account that has gone away, the promote button
 * disabled at the top, and the numbering, which is the whole reason the list is drawn in full rather than
 * summarised in the 14rem trigger beside it. What a click is about to bill, and which account catches it when
 * that one is spent, are both facts you should be able to read without opening anything.
 *
 * THE ROWS' OWN DIFFERENCES STAY WITH THE ROWS, as slots and one flag: what emptying the list falls back to is
 * different copy per row (Auto up there, the composer's pick down here), and only the quick model cares whether
 * a pin thinks before it answers. */

const { entries, warnThinking = false } = defineProps<{
    // The list AS THE USER WROTE IT, described, not the resolved chain. A pin whose account was disconnected
    // still belongs on screen, greyed, because it is a setting they made.
    entries: readonly (DescribedPin & { readonly key: string; readonly index: number })[];
    // Flag a pin that reasons before it answers. True only for the quick model, where thinking is a defect: the
    // job is meant to be instant. An agent run wants the opposite, so the same badge there would be noise.
    warnThinking?: boolean;
}>();
const emit = defineEmits<{ promote: [number]; remove: [number] }>();
</script>

<template>
    <ol class="flex flex-col gap-1">
        <li
            v-for="entry in entries"
            :key="entry.key"
            class="flex items-center gap-2 rounded-md border border-line bg-canvas px-2 py-1 text-xs"
            :class="entry.ready ? `text-content` : `text-subtle`"
        >
            <span class="w-3 shrink-0 text-2xs tabular-nums text-subtle">{{ entry.index + 1 }}</span>
            <ProviderLogo v-if="entry.choice" :provider="entry.choice.provider" class="shrink-0 text-xs text-muted" />
            <span class="min-w-0 flex-1 truncate" v-tooltip.top.overflow="entry.label">{{ entry.label }}</span>
            <!-- A pin whose account is gone stays on the list and says so. The resolver skips it at run time, so
                 the feature keeps working, but silently dropping it from the screen would look like the app had
                 eaten a setting the user made. -->
            <span v-if="!entry.ready" class="shrink-0 text-2xs text-warning">Not connected</span>
            <!-- …and a quick-model pin that will THINK says so too, because nothing else on this screen would.
                 A routed channel publishes one row per reasoning level and spells the level into the id, so
                 `…-flash-high` and `…-flash-low` sit in the dropdown looking like two ordinary models, and
                 picking the wrong one turns a two-second commit message into a half-minute one. Auto is kept off
                 these rows by the ordering itself (contract model-order.ts); a pin is a deliberate choice and is
                 run as written, so the only thing owed here is that the choice be legible after it is made. -->
            <span
                v-else-if="warnThinking && entry.choice && namesThinking(entry.choice.model)"
                class="shrink-0 text-2xs text-warning"
                v-tooltip.top="
                    'This model reasons before it answers: accurate, but seconds slower for a job meant to be instant. A quieter row of the same model is usually the better quick model.'
                "
            >
                Thinks
            </span>
            <button
                type="button"
                class="shrink-0 rounded p-1 text-subtle transition-colors hover:bg-overlay hover:text-content disabled:cursor-not-allowed disabled:opacity-30"
                :disabled="entry.index === 0"
                @click="emit(`promote`, entry.index)"
                v-tooltip.top="'Try this one earlier'"
                :aria-label="`Move ${entry.label} earlier`"
            >
                <Icon name="chevron-up" class="text-2xs" />
            </button>
            <button
                type="button"
                class="shrink-0 rounded p-1 text-subtle transition-colors hover:bg-overlay hover:text-danger"
                @click="emit(`remove`, entry.index)"
                v-tooltip.top="'Remove from the order'"
                :aria-label="`Remove ${entry.label}`"
            >
                <Icon name="times" class="text-2xs" />
            </button>
        </li>
        <!-- What emptying the list does, stated rather than implied: with a list on screen it is not obvious
             that removing the last row hands the choice back to something. The two rows fall back to different
             things, so the sentence belongs to the caller. -->
        <li class="text-2xs text-subtle"><slot name="floor" /></li>
    </ol>
</template>
