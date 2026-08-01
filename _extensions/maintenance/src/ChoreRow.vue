<script setup lang="ts">
import type { ChoreVerdict } from "@intentic/sandbox-contract/chores";
import { Button, Icon, type IconName, StatusBadge, type StatusVariant, timeAgo } from "@intentic/extension-ui";
import { computed } from "vue";
import type { ChoreRun } from "./useRuns";

/* ONE CHORE, IN ONE REPOSITORY. The row has to answer three questions in one line — what is this, is it due, and
 * has anyone looked — and then, opened, show the evidence that decided it.
 *
 * The evidence is the part that matters. A maintenance surface that says "4 things need attention" and cannot
 * show its working is a surface people stop believing on the first row that turns out to be wrong, and after that
 * they stop reading the rest. So every claim here is expandable into the specific packages, files or advisories
 * behind it — and a CLEAR chore expands too, into what was measured and when, because "there is nothing to do
 * here" is only reassuring if you can see what was checked. */

const { verdict, run } = defineProps<{ verdict: ChoreVerdict; run: ChoreRun | undefined; expanded: boolean; busy: boolean }>();
const emit = defineEmits<{ toggle: []; start: []; snooze: []; unsnooze: []; open: [conversationId: string] }>();

// The state, as one badge. `unavailable` is deliberately NOT a warning colour: nothing is wrong, we simply have
// not measured it, and painting that amber would make every repo without knip look broken.
const status = computed<{ variant: StatusVariant; label: string } | undefined>(() => {
    if (verdict.state === `due`) {
        return verdict.severity === `warning` ? { variant: `warning`, label: `carrying` } : { variant: `info`, label: `due` };
    }
    if (verdict.state === `snoozed`) {
        return { variant: `neutral`, label: `snoozed` };
    }
    if (verdict.state === `unavailable`) {
        return { variant: `neutral`, label: `unmeasured` };
    }
    return { variant: `success`, label: `clear` };
});

/* "Ran, and the evidence has not moved since." Said in the row rather than hidden, because the alternative — a
 * chore that silently stops appearing due after a run — is how a surface loses the owner's trust in the other
 * direction: they fix nothing, the row goes quiet, and they conclude it was never real. */
const settledNote = computed<string | undefined>(() =>
    verdict.settled && run !== undefined ? `a turn ran against this exact evidence ${timeAgo(run.manifest.createdAt)}` : undefined,
);

const liveAgent = computed(() => (run?.running === true ? run.manifest.conversationId : undefined));
</script>

<template>
    <div class="border-t border-line/60 first:border-t-0">
        <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-overlay"
            :class="expanded && `bg-overlay`"
            :aria-expanded="expanded"
            @click="emit(`toggle`)"
        >
            <Icon :name="expanded ? `chevron-down` : `chevron-right`" class="shrink-0 text-subtle" />
            <Icon :name="(verdict.chore.icon as IconName)" class="shrink-0 text-subtle" />
            <span class="min-w-0 shrink-0 text-sm text-content">{{ verdict.chore.title }}</span>
            <!-- The headline is the row's whole point, so it takes the flexible column and the title does not:
                 truncating "4 majors waiting, 61 behind in total" to fit a chore name nobody needed re-reading
                 would lose the only part that changes. -->
            <span class="min-w-0 flex-1 truncate text-xs text-subtle">{{ verdict.headline }}</span>
            <Icon v-if="liveAgent" name="spinner" spin class="shrink-0 text-subtle" />
            <StatusBadge v-if="status" :variant="status.variant" :label="status.label" size="xs" />
        </button>

        <div v-if="expanded" class="border-t border-line/60 bg-canvas px-4 py-4 sm:px-6">
            <p class="max-w-[70ch] text-xs text-subtle">{{ verdict.chore.description }}</p>

            <!-- THE RULE, above the evidence and phrased as what WOULD make this due, so it reads the same whether
                 the chore is due or clear. Without it a row is asking to be taken on trust; with it, the reader
                 can disagree with the rule rather than only with the number — which is the disagreement worth
                 having, and the one that improves the book. -->
            <p class="mt-3 max-w-[70ch] text-2xs text-subtle">
                <span class="text-content">{{ verdict.state === `due` ? `Shown because` : `Shows when` }}:</span> {{ verdict.chore.criterion }}
            </p>

            <!-- The evidence, verbatim from the measurement. One claim per line and never summarised further:
                 this is the list the reader checks the rule above against. -->
            <ul v-if="verdict.detail.length > 0" class="mt-3 flex flex-col gap-1">
                <li v-for="line in verdict.detail" :key="line" class="font-mono text-2xs text-content">{{ line }}</li>
            </ul>

            <p v-if="settledNote" class="mt-3 text-2xs text-subtle">{{ settledNote }}</p>

            <!-- The last run, whatever it concluded. A `clean` outcome is shown as prominently as any other: it is
                 the agent saying the findings did not hold up, and that is a result, not a non-event. -->
            <div v-if="run" class="mt-3 flex flex-wrap items-center gap-2 text-2xs text-subtle">
                <span>{{ run.running ? `running` : (run.result?.outcome ?? `no result written`) }} · {{ timeAgo(run.manifest.createdAt) }}</span>
                <button type="button" class="cursor-pointer underline hover:text-content" @click="emit(`open`, run.manifest.conversationId)">
                    open the transcript
                </button>
            </div>
            <p v-if="run?.result?.summary" class="mt-1 max-w-[70ch] text-xs text-content">{{ run.result.summary }}</p>

            <div class="mt-4 flex flex-wrap items-center gap-2">
                <!-- No "start an agent" on a clear or unmeasured chore: a button that spends money proving nothing
                     is wrong is an invitation this surface should not be making. -->
                <Button
                    v-if="verdict.prompt !== undefined && verdict.state !== `clear`"
                    size="small"
                    :label="verdict.chore.stance === `act` ? `Fix it` : `Look into it`"
                    :disabled="busy || liveAgent !== undefined"
                    @click="emit(`start`)"
                >
                    <template #icon><Icon name="play" /></template>
                </Button>
                <Button v-if="liveAgent" size="small" severity="secondary" text label="Watch it" @click="emit(`open`, liveAgent)" />
                <Button
                    v-if="verdict.state === `due`"
                    size="small"
                    severity="secondary"
                    text
                    label="Not now"
                    title="Keep it listed, keep it out of the rail, for a month"
                    @click="emit(`snooze`)"
                />
                <Button v-if="verdict.state === `snoozed`" size="small" severity="secondary" text label="Un-snooze" @click="emit(`unsnooze`)" />
            </div>
        </div>
    </div>
</template>
