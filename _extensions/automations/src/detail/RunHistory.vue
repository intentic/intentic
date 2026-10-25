<!-- An automation's runs as a timeline, newest on top: how each ended, when, and why, with repeats folded into one entry. -->
<script setup lang="ts">
import type { AutomationRun } from "@intentic/sandbox-contract/schemas/automations";
import { formatDateTime, formatDayMonthTime, Icon, toneDot, toneInk, ui } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { since } from "../cronSchedule";
import { host } from "../host";
import { type RunEntry, runEntries } from "./runHistory";
import { t } from "../i18n.js";

const { runs } = defineProps<{ runs: readonly AutomationRun[] }>();

// Enough to see a pattern, few enough that the history never outgrows the instructions beside it.
const FOLDED = 5;
const all = ref(false);
const entries = computed(() => runEntries(runs));
const shown = computed(() => (all.value ? entries.value : entries.value.slice(0, FOLDED)));

// Only a failure carries hue, as on the row: a page that is normally fine would otherwise go green everywhere.
const DOT = {
    completed: toneDot(`success`),
    error: toneDot(`danger`),
    skipped: `bg-content/25`,
    interrupted: toneDot(`warning`),
} satisfies Record<AutomationRun[`outcome`], string>;
const INK = {
    completed: `text-content`,
    error: toneInk(`danger`),
    skipped: `text-muted`,
    interrupted: `text-muted`,
} satisfies Record<AutomationRun[`outcome`], string>;
const verb = (outcome: AutomationRun[`outcome`]): string =>
    ({
        completed: t(`automationRow.outcome.ran`),
        error: t(`automationRow.outcome.failed`),
        skipped: t(`automationRow.outcome.skipped`),
        interrupted: t(`automationRow.outcome.cutOff`),
    })[outcome];

// A guard-skip has no conversation to open.
const open = (entry: RunEntry): void => {
    if (entry.newest.conversationId !== undefined) {
        host().chat.openSession(entry.newest.conversationId);
    }
};
</script>

<template>
    <p v-if="runs.length === 0" class="text-xs text-subtle">{{ t(`automationRow.nothingYetRunNow`) }}</p>
    <div v-else class="flex flex-col">
        <ol class="flex flex-col">
            <li v-for="(entry, index) in shown" :key="entry.newest.at" class="relative">
                <!-- The thread between marks, so the entries read as one history rather than a list of unrelated lines. -->
                <span v-if="index < shown.length - 1" class="absolute bottom-0 left-3 top-4 w-px bg-line" aria-hidden="true"></span>
                <component
                    :is="entry.newest.conversationId ? `button` : `div`"
                    :type="entry.newest.conversationId ? `button` : undefined"
                    class="group/item relative flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-left"
                    :class="entry.newest.conversationId ? `cursor-pointer hover:bg-content/5` : ``"
                    :aria-label="entry.newest.conversationId ? t(`automationRow.openTranscriptRun`, { at: formatDateTime(entry.newest.at) }) : undefined"
                    @click="open(entry)"
                >
                    <span class="mt-1 size-2 shrink-0 rounded-full ring-2 ring-card" :class="DOT[entry.outcome]" aria-hidden="true"></span>
                    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="flex flex-wrap items-baseline gap-x-2 text-xs">
                            <span class="font-medium" :class="INK[entry.outcome]">{{ verb(entry.outcome) }}</span>
                            <span
                                v-if="entry.count > 1"
                                class="rounded-sm bg-content/5 px-1 text-2xs tabular-nums text-muted"
                                v-tooltip.top="{ title: t(`runHistory.inARow`, { count: entry.count }), note: t(`runHistory.firstAt`, { at: formatDateTime(entry.oldestAt) }) }"
                                >×{{ entry.count }}</span
                            >
                            <span class="text-subtle" v-tooltip.top="formatDateTime(entry.newest.at)">{{ since(entry.newest.at) }}</span>
                            <span class="hidden text-2xs text-subtle/70 @md:inline">{{ formatDayMonthTime(entry.newest.at) }}</span>
                        </span>
                        <!-- Wrapped, not cut to one line: the reason is the part of a failure anybody opens this to read. -->
                        <span v-if="entry.detail" class="line-clamp-3 text-2xs leading-relaxed break-words text-muted">{{ entry.detail }}</span>
                    </span>
                    <Icon
                        v-if="entry.newest.conversationId"
                        name="arrow-up-right"
                        class="shrink-0 text-2xs text-subtle opacity-40 transition group-hover/item:opacity-100"
                    />
                </component>
            </li>
        </ol>
        <button v-if="entries.length > FOLDED" type="button" :class="ui.textButton()" class="ml-2 mt-1 self-start" @click="all = !all">
            {{ all ? t(`runHistory.showFewer`) : t(`runHistory.showAll`, { count: runs.length }) }}
        </button>
    </div>
</template>
