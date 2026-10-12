<!-- Bring back: what agents changed in this folder's own sandbox, reviewed and copied into the folder on request, with the folder's sync direction beside it.
     Drawn only with something to say (bringBack.ts `sectionShown`); the folder's page checks for changes on its own (useBringBack.ts `useQuietChecks`). -->
<script setup lang="ts">
import { Button, ConfirmDialog, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { localFace } from "../../app/environments/local";
import type { SandboxChange } from "./bringBack";
import BringBackReview from "./BringBackReview.vue";
import { useBringBack } from "./useBringBack";

// The desktop app keeps a folder and its sandbox in sync, copy-first unless the reader chose otherwise: agents work on
// the sandbox's copy, and nothing of theirs reaches the folder until it is brought back here. Every ask is a link to
// the app and every answer an event (useBringBack.ts), so each line below is a step waiting on, or showing, one answer.

const t = useT();
const { state, shown, check, bringBack, undo, switchTo } = useBringBack();
const step = computed(() => state.value.step);

// The list the review was opened on, held while its copy runs: the step moves on, the box does not.
const reviewing = ref(false);
const reviewed = ref<readonly SandboxChange[]>([]);
const reviewedTruncated = ref(false);
const review = (): void => {
    if (step.value.at !== `checked`) {
        return;
    }
    reviewed.value = step.value.changes;
    reviewedTruncated.value = step.value.truncated;
    reviewing.value = true;
};
// The box closes once the copy landed; a failure stays in it, where the press that failed can be made again.
watch(
    () => step.value.at,
    (at) => {
        if (at === `brought`) {
            reviewing.value = false;
        }
    },
);
const reviewError = computed(() => (reviewing.value && step.value.at === `failed` ? step.value.error : undefined));
// What a bring-back left alone, and why, one per line: the receipt's tooltip.
const skippedLines = computed(() => {
    const now = step.value;
    return now.at === `brought` && now.skipped.length > 0 ? now.skipped.map((skip) => `${skip.path}: ${skip.reason}`).join(`\n`) : undefined;
});
// With an answer on the line, asking again is a glyph at its end; with none, it is the line.
const answeredLine = computed(() => step.value.at === `checked` || step.value.at === `brought` || step.value.at === `restored`);
// The line of steps, unless there is nothing on it: a folder synced both ways with nothing found shows its direction alone.
const lineShown = computed(() => step.value.at !== `idle` && !(step.value.at === `checked` && step.value.changes.length === 0));

// A folder in the sandbox as part of one around it syncs as that one does: its direction is changed from that window.
const partOf = computed(() => localFace()?.partOf);

// Both ways is the reader's choice to make with the risk in front of them; back to copy-first needs no warning.
const confirmingBoth = ref(false);
const syncBothWays = (): void => {
    confirmingBoth.value = false;
    switchTo(`both`);
};
</script>

<template>
    <section v-if="shown" class="flex shrink-0 flex-col gap-1.5 border-t border-line px-3 py-2 text-xs" aria-labelledby="local-bring-back-title">
        <h2 id="local-bring-back-title" :class="ui.sectionLabel({ size: `xs` })">{{ t(`local.localBringBack.title`) }}</h2>
        <p class="text-muted">
            {{ state.direction === `both` ? t(`local.localBringBack.bothWays`) : t(`local.localBringBack.copyFirst`) }}
        </p>
        <div v-if="lineShown" class="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
            <template v-if="step.at === `checked` && step.changes.length > 0">
                <span class="text-content">{{
                    t(`local.localBringBack.changes`, { count: `${step.changes.length}${step.truncated ? `+` : ``}` }, step.changes.length)
                }}</span>
                <span class="text-subtle" aria-hidden="true">·</span>
                <button type="button" :class="ui.textButton()" @click="review">{{ t(`local.localBringBack.review`) }}</button>
            </template>
            <span v-else-if="step.at === `bringing`" class="flex items-center gap-1.5 text-muted">
                <Icon name="spinner" spin class="text-2xs" />{{ t(`local.localBringBack.bringing`, { count: step.count }, step.count) }}
            </span>
            <template v-else-if="step.at === `brought`">
                <span class="text-content" v-tooltip.top="skippedLines">{{
                    step.skipped.length === 0
                        ? t(`local.localBringBack.brought`, { count: step.count }, step.count)
                        : t(`local.localBringBack.broughtSkipped`, { count: step.count, skipped: step.skipped.length }, step.count)
                }}</span>
                <span class="text-subtle" aria-hidden="true">·</span>
                <button type="button" :class="ui.textButton()" @click="undo">{{ t(`ui.action.undo`) }}</button>
            </template>
            <span v-else-if="step.at === `restoring`" class="flex items-center gap-1.5 text-muted">
                <Icon name="spinner" spin class="text-2xs" />{{ t(`local.localBringBack.restoring`) }}
            </span>
            <span v-else-if="step.at === `restored`" class="text-content">{{
                t(`local.localBringBack.restored`, { count: step.count }, step.count)
            }}</span>
            <p v-else-if="step.at === `failed`" class="w-full min-w-0 break-words text-danger">{{ step.error }}</p>
            <button
                v-if="answeredLine"
                type="button"
                :class="ui.iconButton(`ml-auto`)"
                v-tooltip.top="t(`local.localBringBack.checkAgain`)"
                :aria-label="t(`local.localBringBack.checkAgain`)"
                @click="check"
            >
                <Icon name="refresh" class="text-xs" />
            </button>
            <Button
                v-else-if="step.at === `checking` || step.at === `failed`"
                size="small"
                tier="boring"
                :label="t(`local.localBringBack.check`)"
                :loading="step.at === `checking`"
                @click="check"
            />
        </div>
        <button
            v-if="partOf === undefined && state.direction === `both`"
            type="button"
            :class="ui.textButton({ tone: `quiet` })"
            :disabled="state.switching"
            v-tooltip.top="{ title: t(`local.localBringBack.switchToCopyFirst`), note: t(`local.localBringBack.copyFirstHint`) }"
            @click="switchTo(`to-sandbox`)"
        >
            {{ t(`local.localBringBack.switchToCopyFirst`) }}
        </button>
        <button
            v-else-if="partOf === undefined && state.direction === `to-sandbox`"
            type="button"
            :class="ui.textButton({ tone: `quiet` })"
            :disabled="state.switching"
            @click="confirmingBoth = true"
        >
            {{ t(`local.localBringBack.syncBothWays`) }}
        </button>
        <p v-if="state.switchError !== undefined" class="break-words text-danger">{{ state.switchError }}</p>

        <BringBackReview
            v-model:open="reviewing"
            :changes="reviewed"
            :truncated="reviewedTruncated"
            :busy="step.at === `bringing`"
            :error="reviewError"
            @bring="(chosen) => bringBack(reviewed, chosen)"
        />
        <ConfirmDialog
            :open="confirmingBoth"
            :header="t(`local.localBringBack.bothWaysHeader`)"
            :confirm-label="t(`local.localBringBack.bothWaysConfirm`)"
            confirm-icon="sync"
            :description="t(`local.localBringBack.bothWaysWarning`)"
            @cancel="confirmingBoth = false"
            @confirm="syncBothWays"
        />
    </section>
</template>
