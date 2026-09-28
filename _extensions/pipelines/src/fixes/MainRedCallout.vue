<script setup lang="ts">
import { activeLocale, appLink, fixStanceLook, formatDate, formatDayMonthTime, formatTimestamp, Icon } from "@intentic/extension-ui";
import { computed } from "vue";
import { host } from "../host";
import { type MainRedView, waitsForYou } from "./mainReds";
import { t } from "../i18n.js";

// MAIN IS RED, said once at the head of its repository's runs, above the rows that say it run by run: since when, the
// jobs failing now, and who has it. The daemon put one fix agent on it at the first failed job and sends it every later
// failure on the branch until a run passes; this names that agent by its live stance, and turns to "Waits for you" once
// the daemon hands the red back (its turns spent, or it finished without changing anything, or repairs are off). The
// owner's hands stay on the run rows below: this is the one sentence that saves reading them all.

const props = defineProps<{ view: MainRedView }>();

const api = host();

const red = computed(() => props.view.red);
const waits = computed(() => waitsForYou(props.view));
const look = computed(() => (props.view.stance === undefined ? undefined : fixStanceLook(props.view.stance.kind)));

// The fixer's newest attempt when the fleet has it, else the conversation the red names, which the chat can still open
// from the archive.
const fixerId = computed(() => props.view.fixer?.id ?? red.value.fixer);
const fixerLink = computed(() => {
    const id = fixerId.value;
    return id === undefined ? undefined : appLink(api.href(`/agents/${id}`), () => api.chat.openAgent(id));
});

// Why it waits, in the sandbox's words when it said any.
const waitDetail = computed(() => red.value.decision?.detail ?? (props.view.state === `reported` ? t(`mainRed.reported`) : t(`mainRed.spent`)));

// The wall-clock minute it went red, with its day once it is not today's: "10:20", "Sep 24, 09:10". The house clock is
// 24-hour in every language (format.ts), so the hour is pinned rather than left to the locale.
const clockOf = (at: number): string => new Intl.DateTimeFormat(activeLocale.value, { hour: `2-digit`, minute: `2-digit`, hour12: false }).format(at);
const since = computed(() =>
    formatDate(red.value.since) === formatDate(Date.now()) ? clockOf(red.value.since) : formatDayMonthTime(red.value.since),
);
</script>

<template>
    <!-- The run rows' own left stripe, in the one tone a broken branch wears; the wash says this line is about all of them. -->
    <div
        :data-main-red="`${red.repo}:${red.branch}`"
        :data-state="view.state"
        class="flex flex-col gap-2 border-l-4 border-l-danger bg-danger/5 px-4 py-3"
    >
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <Icon name="exclamation-circle" class="shrink-0 text-sm text-danger" />
            <span class="text-sm font-semibold text-content">{{ t(`mainRed.title`, { branch: red.branch }) }}</span>
            <span class="text-2xs text-subtle" :title="formatTimestamp(red.since)">{{ t(`mainRed.since`, { when: since }) }}</span>
            <a
                v-if="view.run !== undefined"
                :href="view.run.url"
                target="_blank"
                rel="noopener"
                class="touch-target text-2xs text-subtle hover:text-link"
                >{{ t(`mainRed.newestRun`, { runId: red.runId }) }}</a
            >
        </div>

        <div v-if="red.jobs.length > 0" class="flex min-w-0 flex-wrap items-center gap-1.5">
            <span class="mr-0.5 text-2xs text-subtle">{{ t(`mainRed.failing`) }}</span>
            <span
                v-for="job in red.jobs"
                :key="job"
                class="inline-flex max-w-full items-center rounded-md border border-danger/20 bg-canvas px-2 py-0.5 font-mono text-2xs text-danger"
            >
                <span class="truncate">{{ job }}</span>
            </span>
        </div>

        <!-- Handed back: the owner's now, in the daemon's own sentence, with the way into what the agent tried. -->
        <div v-if="waits" data-waits class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
            <span class="inline-flex shrink-0 items-center gap-1.5 font-medium text-warning">
                <Icon name="exclamation-triangle" class="text-2xs" />
                {{ t(`mainRed.waitsForYou`) }}
            </span>
            <span class="min-w-0 text-muted">{{ waitDetail }}</span>
            <a v-if="fixerLink !== undefined" v-bind="fixerLink" class="touch-target shrink-0 font-medium text-link hover:underline">{{
                t(`mainRed.openFixer`)
            }}</a>
        </div>

        <!-- The one agent on it: its live stance as the run rows draw it, then its conversation. One link, one stop. -->
        <div v-else-if="view.state === `fixing`" data-fixer class="flex min-w-0 items-center gap-2 text-xs">
            <span class="shrink-0 text-subtle" v-tooltip.top="t(`mainRed.fixAgentHint`, { branch: red.branch })">{{ t(`mainRed.fixAgent`) }}</span>
            <a
                v-if="fixerLink !== undefined"
                v-bind="fixerLink"
                class="group/a flex min-w-0 items-center gap-2"
                v-tooltip.top="view.stance?.hint ?? red.decision?.detail"
            >
                <span
                    v-if="view.stance !== undefined && look !== undefined"
                    class="ui-chip shrink-0 rounded px-2 py-0.5 text-xs font-medium"
                    :class="[look.ink, look.chip]"
                >
                    <Icon :name="look.icon" :spin="look.spin" class="text-2xs" />
                    {{ view.stance.label }}
                </span>
                <span v-if="view.fixer?.title !== undefined" class="min-w-0 truncate text-muted group-hover/a:text-content">{{
                    view.fixer.title
                }}</span>
                <span class="shrink-0 font-medium text-link">{{ t(`mainRed.open`) }}</span>
            </a>
        </div>

        <p v-else class="text-xs text-subtle">{{ t(`mainRed.unassigned`) }}</p>
    </div>
</template>
