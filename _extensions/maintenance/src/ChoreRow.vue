<script setup lang="ts">
import { type ChoreVerdict, repoName } from "@intentic/sandbox-contract/chores";
import { AgentRunButton, type AgentRunChoice, Button, Icon, type IconName, StatusBadge, type StatusVariant, timeAgo, useAgentRunPick } from "@intentic/extension-ui";
import { host } from "./host";
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

/* `showRepo` rather than a repo string, because the row already knows which repository it belongs to — what it
 * cannot know is whether the list around it spans more than one. On a list scoped to a single repository the mark
 * is the same word on every row, which is noise; across repositories it is the only thing telling two otherwise
 * identical rows apart. */
const { verdict, run } = defineProps<{ verdict: ChoreVerdict; run: ChoreRun | undefined; expanded: boolean; showRepo: boolean; busy: boolean }>();
const emit = defineEmits<{
    toggle: [];
    start: [pick: AgentRunChoice | undefined];
    snooze: [];
    unsnooze: [];
    open: [conversationId: string];
}>();

/* Which model this chore's turn opens on, and the caret that re-points it for this chore alone. Per ROW, because
 * a board of chores starts many runs and the tier is a judgement about the one in front of you — "look into a
 * flaky suite" and "fix a dependency bump" are not worth the same session. Seeded from the sandbox's agent-run
 * list, asked of the host so the button and the daemon cannot disagree about what a click costs. */
const runModel = useAgentRunPick(() => host().models);
const startRun = (): void => {
    emit(`start`, runModel.overridden.value ? runModel.model.value : undefined);
    runModel.clear();
};

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
    <!-- A @container: whether this row can hold its title and its headline on one line is a fact about the ROW,
         and the row is as wide as a workspace pane the reader can shrink to a third of the window. -->
    <div class="@container border-t border-line/60 first:border-t-0">
        <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-overlay"
            :class="expanded && `bg-overlay`"
            :aria-expanded="expanded"
            @click="emit(`toggle`)"
        >
            <Icon :name="expanded ? `chevron-down` : `chevron-right`" class="shrink-0 text-subtle" />
            <Icon :name="verdict.chore.icon as IconName" class="shrink-0 text-subtle" />
            <!-- ONE LINE WITH ROOM FOR IT, TWO WITHOUT. On a wide row the title keeps its full width and the
                 headline takes the flexible column: truncating "4 majors waiting, 61 behind in total" to fit a
                 chore name nobody needed re-reading would lose the only part that changes. In a narrow pane there
                 is no column wide enough for both, and the row that tried spilled its state badge off the card — so
                 the two stack, each truncating on its own line, and the badge stays where it can be read. -->
            <span class="flex min-w-0 flex-1 flex-col gap-0.5 @lg:flex-row @lg:items-center @lg:gap-3">
                <span class="@lg:shrink-0 flex min-w-0 items-center gap-2">
                    <span class="min-w-0 truncate text-sm text-content">{{ verdict.chore.title }}</span>
                    <span v-if="showRepo" class="shrink-0 rounded bg-content/[0.06] px-1.5 py-0.5 text-2xs text-subtle">
                        {{ repoName(verdict.repo) }}
                    </span>
                </span>
                <span class="min-w-0 flex-1 truncate text-xs text-subtle">{{ verdict.headline }}</span>
            </span>
            <Icon v-if="liveAgent" name="spinner" spin class="shrink-0 text-subtle" />
            <StatusBadge v-if="status" :variant="status.variant" :label="status.label" size="xs" class="shrink-0" />
        </button>

        <div v-if="expanded" class="border-t border-line/60 bg-canvas px-4 py-4 @lg:px-6">
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
                <AgentRunButton
                    v-if="verdict.prompt !== undefined && verdict.state !== `clear`"
                    :label="verdict.chore.stance === `act` ? `Fix it` : `Look into it`"
                    icon="play"
                    :model-label="runModel.model.value.label"
                    :overridden="runModel.overridden.value"
                    :disabled="busy || liveAgent !== undefined"
                    @run="startRun"
                    @pick="runModel.choose"
                />
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
