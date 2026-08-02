<script setup lang="ts">
import { probeSpec } from "@intentic/sandbox-contract/chores";
import { Icon, timeAgo } from "@intentic/extension-ui";
import type { ProbeResult } from "@intentic/sandbox-contract";
import { computed } from "vue";

/* WHAT WE MEASURED, AND WHEN. A strip above each repository's chores rather than a detail buried inside them,
 * because it answers the question a reader has before they trust any row: is this current?
 *
 * Probes refresh on a daily-to-weekly TTL, so "clean" from a measurement taken last Tuesday is a genuinely
 * different claim from "clean" as of an hour ago, and a panel that showed only the verdict would be quietly
 * passing off the one as the other. Naming the age here — once per repository, in small type — costs a line and
 * makes every chore below it honest.
 *
 * A probe that could not run says so in the same strip, but NOT as an entry of its own. Those two halves are the
 * design: an entry is a measurement, carrying a name, an age and a button that would get you a fresher one, and
 * "there is no package.json here" is none of those things. Rendered as entries they were four grey sentences and
 * four buttons that could not change anything — a repository that simply is not a JS project reading as a wall of
 * failures. So they collapse into one dim clause below the measurements, grouped by what is MISSING rather than
 * by probe, because one missing package.json is one fact about the repository and not four separate apologies.
 *
 * It is still said, and said up front: a reader deciding whether the list below is complete needs to know what
 * could not be looked at, and "unmeasured" quietly rendering as nothing is how a maintenance panel ends up
 * implying a green repository it has never measured. */

const { probes } = defineProps<{ probes: readonly ProbeResult[]; busy: boolean }>();
const emit = defineEmits<{ refresh: [id: string] }>();

const measured = computed(() =>
    probes
        .filter((probe) => probe.state !== `unavailable`)
        .map((probe) => {
            const spec = probeSpec(probe.id);
            return {
                probe,
                title: spec.title,
                measures: spec.measures,
                /* What this probe has to say for itself: an age when it measured something, and otherwise how it
                 * broke. Truncated in the strip and given in full on hover — a failure carries the tool's own
                 * words, which are as long as the tool felt like being, and one of them wrapping across four
                 * lines would push every other measurement off the strip. */
                note: probe.state === `ok` ? timeAgo(probe.ranAt) : (probe.reason ?? `failed`),
                // A tier-2 probe can run for minutes, so the reader gets told what they are asking for before they
                // press the button rather than after the sandbox goes quiet.
                cost: spec.tier === 2 ? ` · takes a few minutes` : ``,
            };
        }),
);

/* The probes this repository cannot run, as "<what is missing> (<the probes it costs>)". Reason first because the
 * reason is the part that can change and the part worth acting on; the probe names are the consequence.
 *
 * No refresh button on any of them. `available` is the cheapest thing the runner does and it re-checks every
 * unavailable probe hourly (chores-store's RETRY_MS), so a repository that adds knip this morning is measured
 * this afternoon without anyone asking — a button here would only offer to do sooner what is already happening. */
const unmeasurable = computed(() => {
    const byReason = new Map<string, string[]>();
    for (const probe of probes) {
        if (probe.state !== `unavailable`) {
            continue;
        }
        const reason = probe.reason ?? `not available in this repository`;
        byReason.set(reason, [...(byReason.get(reason) ?? []), probeSpec(probe.id).title.toLowerCase()]);
    }
    return [...byReason].map(([reason, titles]) => `${reason} (${titles.join(`, `)})`);
});
</script>

<template>
    <div v-if="measured.length > 0 || unmeasurable.length > 0" class="flex flex-col gap-1.5 border-b border-line/60 px-4 py-2">
        <div v-if="measured.length > 0" class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span class="text-2xs text-subtle">measured</span>
            <div v-for="entry in measured" :key="entry.probe.id" class="flex items-center gap-1.5">
                <Icon
                    :name="entry.probe.state === `ok` ? `check-circle` : `exclamation-circle`"
                    class="shrink-0 text-2xs"
                    :class="entry.probe.state === `failed` ? `text-warning` : `text-subtle`"
                />
                <span class="shrink-0 text-2xs text-content">{{ entry.title }}</span>
                <span class="max-w-[36ch] truncate text-2xs text-subtle" :title="entry.note">{{ entry.note }}</span>
                <button
                    type="button"
                    class="shrink-0 cursor-pointer text-subtle hover:text-content disabled:cursor-default disabled:opacity-40"
                    :disabled="busy"
                    :title="`Measure ${entry.measures} again now${entry.cost}`"
                    @click="emit(`refresh`, entry.probe.id)"
                >
                    <Icon name="refresh" class="text-2xs" />
                </button>
            </div>
        </div>

        <!-- Same shape and same weight as the "Not applicable here" footer under the rows, because it is the same
             kind of statement: something this surface considered and could not speak to, kept one glance away
             rather than made into a row that competes with the work. -->
        <p v-if="unmeasurable.length > 0" class="text-2xs text-subtle">
            <span class="text-content">Not measurable here —</span> {{ unmeasurable.join(`; `) }}.
        </p>
    </div>
</template>
