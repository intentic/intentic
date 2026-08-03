<script setup lang="ts">
import { type ChoreVerdict, probeSpec } from "@intentic/sandbox-contract/chores";
import { Icon, timeAgo } from "@intentic/extension-ui";
import type { ProbeResult } from "@intentic/sandbox-contract";
import { computed } from "vue";

/* WHAT THIS REPOSITORY CAN BE ASKED, AND WHAT WE ACTUALLY ASKED IT. One strip above the chores rather than three
 * details spread through them, because all three answer the question a reader has before they trust any row: is
 * the list below complete, and is it current?
 *
 *   measured           the probes that ran, and how long ago. Probes refresh on a daily-to-weekly TTL, so "clean"
 *                      from last Tuesday is a genuinely different claim from "clean" as of an hour ago, and a
 *                      panel that showed only the verdict would quietly pass off the one as the other.
 *   not measurable     no package.json, no lockfile, knip not installed. Grouped by what is MISSING rather than
 *                      by probe, because one absent package.json is one fact about the repository, not four
 *                      separate apologies — and it carries no refresh button, because `available` is re-checked
 *                      hourly by the runner anyway (chores-store's RETRY_MS).
 *   not applicable     the chores whose SUBJECT does not exist here — no Dockerfile to slim, no pipeline to
 *                      tighten. Those rows are dropped from the list entirely (verdict.ts), and this is the
 *                      record that they were considered, so "why is there no Docker chore in this repo?" has an
 *                      answer one glance away rather than a support question.
 *
 * They were three separate things — two of them inside a per-repo probe strip, one a footer under the rows, shown
 * only under the "Everything" filter. Same weight, same dim type, same kind of statement: something this surface
 * considered and cannot speak to. Saying them in one place is what makes the strip a STATEMENT OF SCOPE rather
 * than a row of measurements with two apologies stapled to it, and it is why the "not applicable" half no longer
 * hides behind a filter: the reader deciding whether to trust this list needs it in both.
 *
 * Repo-scoped, so it only renders when the rail has a repository selected. There is no honest way to say "we
 * measured this 3 hours ago" about four repositories at once. */

const { probes, inapplicable } = defineProps<{ probes: readonly ProbeResult[]; inapplicable: readonly ChoreVerdict[]; busy: boolean }>();
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

// The probes this repository cannot run, as "<what is missing> (<the probes it costs>)". Reason first because the
// reason is the part that can change and the part worth acting on; the probe names are the consequence.
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

// A not-applicable verdict carries its reason as the headline (verdict.ts), which is the only place it is ever
// read.
const ruledOut = computed(() => inapplicable.map((verdict) => `${verdict.chore.title.toLowerCase()} (${verdict.headline})`));
</script>

<template>
    <!-- A WASH, not an outlined box. It sits between the page title and a column of bordered row groups, and an
         outline at that position reads as a third panel competing with both — the same call Documentation's
         strips make, for the same reason. -->
    <div
        v-if="measured.length > 0 || unmeasurable.length > 0 || ruledOut.length > 0"
        class="flex flex-col gap-1.5 rounded-lg bg-content/[0.04] px-3 py-2"
    >
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

        <p v-if="unmeasurable.length > 0" class="text-2xs text-subtle">
            <span class="text-content">Not measurable here —</span> {{ unmeasurable.join(`; `) }}.
        </p>

        <p v-if="ruledOut.length > 0" class="text-2xs text-subtle">
            <span class="text-content">Not applicable here —</span> {{ ruledOut.join(`; `) }}.
        </p>
    </div>
</template>
