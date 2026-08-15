<script setup lang="ts">
import { type ChoreVerdict, probeSpec } from "@intentic/sandbox-contract/chores";
import { Icon, timeAgo } from "@intentic/extension-ui";
import type { ProbeResult } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";

/* WHAT THIS REPOSITORY CAN BE ASKED, AND WHAT WE ACTUALLY ASKED IT. One strip above the chores rather than three
 * details spread through them, because all three answer the question a reader has before they trust any row: is
 * the list below complete, and is it current?
 *
 *   measured           the probes that ran, and how long ago. Probes refresh on a daily-to-weekly TTL, so "clean"
 *                      from last Tuesday is a genuinely different claim from "clean" as of an hour ago, and a
 *                      panel that showed only the verdict would quietly pass off the one as the other.
 *   not measured       no package.json, no lockfile, knip not installed — the probes this repository cannot run.
 *                      No refresh button, because `available` is re-checked hourly by the runner anyway
 *                      (chores-store's RETRY_MS).
 *   not applicable     the chores whose SUBJECT does not exist here — no Dockerfile to slim, no pipeline to
 *                      tighten. Those rows are dropped from the list entirely (verdict.ts), and this is the
 *                      record that they were considered, so "why is there no Docker chore in this repo?" has an
 *                      answer one glance away rather than a support question.
 *
 * A COUNT, THEN THE REASONS ON REQUEST. Both of the "no" halves used to be printed in full, every time: thirteen
 * chores each carrying a sentence explaining itself, wrapping to eight lines of grey text above a list of two
 * rows. It was accurate and nobody read it — and text nobody reads is worse than absent, because it buys the
 * silence of the reader rather than their agreement. What the reader actually needs standing is the SIZE of what
 * is missing; the reasons are what they want once, when something surprises them.
 *
 * So the strip states the scope in one line and opens to the reasons. What made the opened form short enough to
 * be worth opening is grouping BY CAUSE rather than by chore (chores.ts phrases each gate as a bare cause for
 * exactly this): a workspace root has thirteen chores ruled out by three facts about itself, and saying those
 * three facts once each, with the names they cost beside them, is the same information at a fifth of the words.
 *
 * Repo-scoped, so it only renders when the rail has a repository selected. There is no honest way to say "we
 * measured this 3 hours ago" about four repositories at once. */

// `measuring` arrives as the keyed set rather than the list the rows take: this strip asks one yes/no question
// per probe and has no use for when it started.
const { probes, inapplicable, measuring, repo } = defineProps<{
    probes: readonly ProbeResult[];
    inapplicable: readonly ChoreVerdict[];
    measuring: ReadonlySet<string>;
    repo: string;
    busy: boolean;
}>();
const emit = defineEmits<{ refresh: [id: string] }>();

const open = ref(false);

const measured = computed(() =>
    probes
        .filter((probe) => probe.state !== `unavailable`)
        .map((probe) => {
            const spec = probeSpec(probe.id);
            const running = measuring.has(`${repo}|${probe.id}`);
            return {
                probe,
                running,
                title: spec.title,
                measures: spec.measures,
                /* What this probe has to say for itself: an age when it measured something, and otherwise how it
                 * broke. Truncated in the strip and given in full on hover — a failure carries the tool's own
                 * words, which are as long as the tool felt like being, and one of them wrapping across four
                 * lines would push every other measurement off the strip.
                 *
                 * While it is running the age is REPLACED rather than annotated: "16h ago" beside a spinner is
                 * the panel describing the measurement it is in the middle of throwing away. */
                note: running ? `measuring…` : probe.state === `ok` ? timeAgo(probe.ranAt) : (probe.reason ?? `failed`),
                // A tier-2 probe can run for minutes, so the reader gets told what they are asking for before they
                // press the button rather than after the sandbox goes quiet.
                cost: spec.tier === 2 ? ` · takes a few minutes` : ``,
            };
        }),
);

// One line per distinct cause, carrying everything that cause costs. Insertion-ordered, so the reasons come out
// in the order the book put the probes and chores in rather than alphabetically by whatever is missing.
const byCause = (entries: readonly { cause: string; name: string }[]): { cause: string; names: string[] }[] => {
    const groups = new Map<string, string[]>();
    for (const { cause, name } of entries) {
        groups.set(cause, [...(groups.get(cause) ?? []), name]);
    }
    return [...groups].map(([cause, names]) => ({ cause, names }));
};

const unmeasured = computed(() =>
    byCause(
        probes.flatMap((probe) =>
            probe.state === `unavailable`
                ? [{ cause: probe.reason ?? `not available in this repository`, name: probeSpec(probe.id).title.toLowerCase() }]
                : [],
        ),
    ),
);

// A not-applicable verdict carries its cause as the headline (verdict.ts), which is the only place it is ever
// read — and the reason that headline is a bare clause rather than a sentence is this grouping.
const ruledOut = computed(() => byCause(inapplicable.map((verdict) => ({ cause: verdict.headline, name: verdict.chore.title.toLowerCase() }))));

// The one line that is always visible, and the only part of the two "no" halves most readers ever need. Counts
// the CHORES and the MEASUREMENTS, not the causes: "3 measurements unavailable" is a fact about how much of the
// panel is missing, where "2 causes" would be a fact about this component.
const summary = computed(() => {
    const missing = unmeasured.value.reduce((total, group) => total + group.names.length, 0);
    return [
        inapplicable.length === 0 ? undefined : `${inapplicable.length} ${inapplicable.length === 1 ? `chore does` : `chores do`} not apply here`,
        missing === 0 ? undefined : `${missing} ${missing === 1 ? `measurement` : `measurements`} unavailable`,
    ]
        .filter((clause) => clause !== undefined)
        .join(` · `);
});
</script>

<template>
    <!-- A WASH, not an outlined box. It sits between the page title and a column of bordered row groups, and an
         outline at that position reads as a third panel competing with both — the same call Documentation's
         strips make, for the same reason. -->
    <div v-if="measured.length > 0 || summary !== ``" class="flex flex-col gap-1.5 rounded-lg bg-content/4 px-3 py-2">
        <div v-if="measured.length > 0" class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span class="text-2xs text-subtle">measured</span>
            <div v-for="entry in measured" :key="entry.probe.id" class="flex items-center gap-1.5">
                <Icon v-if="entry.running" name="spinner" spin class="shrink-0 text-2xs text-info" />
                <Icon
                    v-else
                    :name="entry.probe.state === `ok` ? `check-circle` : `exclamation-circle`"
                    class="shrink-0 text-2xs"
                    :class="entry.probe.state === `failed` ? `text-warning` : `text-subtle`"
                />
                <span class="shrink-0 text-2xs text-content">{{ entry.title }}</span>
                <span class="max-w-read-xs truncate text-2xs" :class="entry.running ? `text-info` : `text-subtle`" :title="entry.note">
                    {{ entry.note }}
                </span>
                <!-- The button holds its place while the probe runs rather than disappearing, so the strip does
                     not reflow under the pointer that just pressed it — and so there is somewhere to look. -->
                <button
                    type="button"
                    class="shrink-0 cursor-pointer text-subtle hover:text-content disabled:cursor-default disabled:opacity-40"
                    :disabled="busy || entry.running"
                    :title="entry.running ? `Measuring ${entry.measures} now` : `Measure ${entry.measures} again now${entry.cost}`"
                    @click="emit(`refresh`, entry.probe.id)"
                >
                    <Icon :name="entry.running ? `spinner` : `refresh`" :spin="entry.running" class="text-2xs" />
                </button>
            </div>
        </div>

        <template v-if="summary !== ``">
            <button
                type="button"
                class="flex cursor-pointer items-center gap-1.5 self-start text-2xs text-subtle hover:text-content"
                :aria-expanded="open"
                @click="open = !open"
            >
                <Icon :name="open ? `chevron-down` : `chevron-right`" class="text-2xs" />
                <span>{{ summary }}</span>
            </button>

            <!-- Cause on the left, what it costs on the right. Two blocks rather than one, because "we cannot ask
                 this question here" and "we have not measured it" are the distinction verdict.ts exists to keep,
                 and a reader scanning for the chore they expected needs to know which of the two answers it. -->
            <!-- A @container so the cause/cost pair splits into two columns on the width THIS block has, which is
                 the workspace pane's, not the window's. -->
            <div v-if="open" class="@container flex flex-col gap-2 pt-0.5 pl-4">
                <div
                    v-for="block in [
                        { label: `Not applicable`, groups: ruledOut },
                        { label: `Not measured`, groups: unmeasured },
                    ]"
                    :key="block.label"
                >
                    <template v-if="block.groups.length > 0">
                        <p class="text-2xs text-content">{{ block.label }}</p>
                        <dl class="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 @md:grid-cols-facts">
                            <template v-for="group in block.groups" :key="group.cause">
                                <dt class="text-2xs text-subtle">{{ group.cause }}</dt>
                                <dd class="text-2xs text-subtle/70">{{ group.names.join(` · `) }}</dd>
                            </template>
                        </dl>
                    </template>
                </div>
            </div>
        </template>
    </div>
</template>
