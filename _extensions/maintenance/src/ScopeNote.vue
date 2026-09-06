<script setup lang="ts">
import { type ChoreVerdict, probeSpec } from "@intentic/sandbox-contract/chores";
import { Icon, ui } from "@intentic/extension-ui";
import type { ProbeResult } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";

/* WHAT THIS REPOSITORY WAS NOT ASKED, as a footnote under the list rather than a banner over it.
 *
 * Three things belong here, and they are all the same kind of thing: a record that something was CONSIDERED and
 * left out, which is what stops "why is there no Docker chore in this repository?" being a support question.
 *
 *   not applicable   the chores whose SUBJECT does not exist here: no Dockerfile to slim, no pipeline to tighten.
 *                    Those rows are dropped from the list entirely (verdict.ts), so this is their only record.
 *   not measured     no package.json, no lockfile, knip not installed: the probes this repository cannot run.
 *   failed           the probe ran and the tool broke, in the tool's own words.
 *
 * IT IS A FOOTNOTE BECAUSE IT ANSWERS A SECOND QUESTION. This was a strip above the chores, listing every probe
 * with its age and a refresh button beside it, and it was the first thing on the page under the title: eight
 * chips of grey text, seven refresh buttons and a disclosure, before a single chore. The freshness half of it is
 * now redundant, every row carries `measured 9h ago` beside the numbers it qualifies, which is where the eye
 * already is when it reads "279 unreferenced files"; and the re-measure it offered lives on the row that rests
 * on the probe (ChoreRow), which is where the page's own Reload hint has always pointed. What is left is an
 * audit trail, and an audit trail read once belongs after the thing it qualifies, not in front of it.
 *
 * A COUNT, THEN THE REASONS ON REQUEST. All three halves used to be printed in full, every time: thirteen chores
 * each carrying a sentence explaining itself. It was accurate and nobody read it, and text nobody reads is worse
 * than absent, because it buys the silence of the reader rather than their agreement. What made the opened form
 * short enough to be worth opening is grouping BY CAUSE rather than by chore (chores.ts phrases each gate as a
 * bare cause for exactly this): a workspace root has thirteen chores ruled out by three facts about itself, and
 * saying those three facts once each, with the names they cost beside them, is a fifth of the words.
 *
 * Repo-scoped, so it only renders when the rail has a repository selected. There is no honest way to say "this
 * could not be measured here" about four repositories at once. */

const { probes, inapplicable } = defineProps<{
    probes: readonly ProbeResult[];
    inapplicable: readonly ChoreVerdict[];
}>();

const open = ref(false);

// One line per distinct cause, carrying everything that cause costs. Insertion-ordered, so the reasons come out
// in the order the book put the probes and chores in rather than alphabetically by whatever is missing.
const byCause = (entries: readonly { cause: string; name: string }[]): { cause: string; names: string[] }[] => {
    const groups = new Map<string, string[]>();
    for (const { cause, name } of entries) {
        groups.set(cause, [...(groups.get(cause) ?? []), name]);
    }
    return [...groups].map(([cause, names]) => ({ cause, names }));
};

const probesInState = (state: ProbeResult["state"]): { cause: string; names: string[] }[] =>
    byCause(
        probes.flatMap((probe) =>
            probe.state === state ? [{ cause: probe.reason ?? `not available in this repository`, name: probeSpec(probe.id).title.toLowerCase() }] : [],
        ),
    );

const unmeasured = computed(() => probesInState(`unavailable`));

/* A FAILURE IS NOT AN ABSENCE, and it is the one line here that is about something being wrong: the tool ran and
 * did not produce a report. It kept its own count rather than joining "unavailable" because the fix is different
 * in kind: "knip is not a devDependency" is a fact about the repository, "the command exited without output" is
 * a thing to go and look at. The row that rests on the probe says the same thing in full (verdict.ts writes it
 * into the chore's detail), and this is the count that says how much of the page it costs. */
const failed = computed(() => probesInState(`failed`));

// A not-applicable verdict carries its cause as the headline (verdict.ts), which is the only place it is ever
// read, and the reason that headline is a bare clause rather than a sentence is this grouping.
const ruledOut = computed(() => byCause(inapplicable.map((verdict) => ({ cause: verdict.headline, name: verdict.chore.title.toLowerCase() }))));

const total = (groups: { names: string[] }[]): number => groups.reduce((sum, group) => sum + group.names.length, 0);
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

// The one line that is always visible, and the only part most readers ever need. Counts the CHORES and the
// MEASUREMENTS, not the causes: "3 measurements unavailable" is a fact about how much of the page is missing,
// where "2 causes" would be a fact about this component.
const summary = computed(() =>
    [
        inapplicable.length === 0 ? undefined : `${plural(inapplicable.length, `chore does`, `chores do`)} not apply here`,
        total(unmeasured.value) === 0 ? undefined : `${plural(total(unmeasured.value), `measurement`, `measurements`)} unavailable`,
        total(failed.value) === 0 ? undefined : `${plural(total(failed.value), `measurement`, `measurements`)} failed`,
    ]
        .filter((clause) => clause !== undefined)
        .join(` · `),
);

const blocks = computed(() =>
    [
        { label: `Not applicable`, groups: ruledOut.value },
        { label: `Not measured`, groups: unmeasured.value },
        { label: `Measurement failed`, groups: failed.value },
    ].filter((block) => block.groups.length > 0),
);
</script>

<template>
    <!-- A rule and some grey text, no wash and no outline: it sits under a column of bordered row groups, and a
         panel down here would read as a fifth kind group rather than as a note about the four above it. -->
    <div v-if="summary !== ``" class="border-t border-line/60 pt-3">
        <button type="button" :class="ui.textAction(`text-2xs text-subtle`)" :aria-expanded="open" @click="open = !open">
            <Icon :name="open ? `chevron-down` : `chevron-right`" class="text-2xs" />
            <span>{{ summary }}</span>
        </button>

        <!-- Cause on the left, what it costs on the right. Separate blocks rather than one list, because "we
             cannot ask this question here", "we have not measured it" and "the tool broke" are the distinctions
             verdict.ts exists to keep, and a reader scanning for the chore they expected needs to know which of
             the three answers it. -->
        <!-- A @container so the cause/cost pair splits into two columns on the width THIS block has, which is
             the workspace pane's, not the window's. -->
        <div v-if="open" class="@container flex flex-col gap-2 pt-1.5 pl-4">
            <div v-for="block in blocks" :key="block.label">
                <p class="text-2xs text-content">{{ block.label }}</p>
                <dl class="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 @md:grid-cols-facts">
                    <template v-for="group in block.groups" :key="group.cause">
                        <dt class="text-2xs text-subtle">{{ group.cause }}</dt>
                        <dd class="text-2xs text-subtle/70">{{ group.names.join(` · `) }}</dd>
                    </template>
                </dl>
            </div>
        </div>
    </div>
</template>
