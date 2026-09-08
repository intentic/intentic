<script setup lang="ts">
import { ui } from "@intentic/ui";
import { namesThinking } from "@intentic/sandbox-contract";
import type { DescribedPin } from "../../../chat/models/modelPins";
import ProviderLogo from "../../../chat/accounts/ProviderLogo.vue";

// Ordered list of pinned models (numbered in try order); the shared body of every role row in Sandbox > Agent > Models.
// The row label is itself the button back into the model picker (re-point the pin, adjust its effort); per-row
// differences (`noteThinking`, `detail`) stay on the row rather than a shared control beside the list.

const { entries, noteThinking = false } = defineProps<{
    // As written, not resolved: a disconnected pin still shows, greyed. `detail` names how it runs, if set.
    entries: readonly (DescribedPin & { readonly key: string; readonly index: number; readonly detail?: string | undefined })[];
    // Flags a reasoning pin, meaningful for one-shot jobs where the added latency matters; noise for a session.
    noteThinking?: boolean;
}>();
const emit = defineEmits<{ promote: [number]; remove: [number]; edit: [number, HTMLElement] }>();
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
            <!-- The whole name is the trigger (and the picker's anchor), not just an icon beside it. -->
            <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2 rounded text-left transition-colors hover:text-link"
                :aria-label="`Change ${entry.label}`"
                @click="emit(`edit`, entry.index, $event.currentTarget as HTMLElement)"
            >
                <ProviderLogo v-if="entry.choice" :provider="entry.choice.provider" class="shrink-0 text-xs text-muted" />
                <!-- Minimum width on the name: without it, a long `detail` (flex-1, zero basis) would squeeze the name away first. -->
                <span class="min-w-[6rem] flex-1 truncate" v-tooltip.top.overflow="entry.label">{{ entry.label }}</span>
                <!-- Shows only fields actually set, so provider defaults add nothing to read; truncates with its own tooltip. -->
                <span v-if="entry.detail" class="min-w-0 shrink truncate text-2xs text-subtle" v-tooltip.top.overflow="entry.detail">{{
                    entry.detail
                }}</span>
            </button>
            <!-- Stays listed rather than dropped: the resolver skips it at runtime, but hiding it would look like a lost setting. -->
            <span v-if="!entry.ready" class="shrink-0 text-2xs text-warning">Not connected</span>
            <!--
                Flags a one-shot pin that reasons before answering, since routed ids (e.g. `...-flash-high`) look like ordinary models and are easy
                to pick by mistake. A note, not a warning: these pins run exactly as chosen.
            -->
            <span
                v-else-if="noteThinking && entry.choice && namesThinking(entry.choice.model)"
                class="shrink-0 text-2xs text-subtle"
                v-tooltip.top="
                    'This model reasons before it answers: better judgement, and seconds slower on a job that usually lands while you are still looking at it. Run as written.'
                "
            >
                Thinks
            </span>
            <button
                type="button"
                :class="ui.iconButton(`h-auto w-auto shrink-0 rounded p-1 text-subtle`)"
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
    </ol>
</template>
