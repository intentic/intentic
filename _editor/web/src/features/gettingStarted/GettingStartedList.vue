<!-- The getting-started checklist itself: where a first run stands, one row per step, the next one ready to press. The
     same list on the rail's popover and on a phone's Menu tab. A row is done when the sandbox says so (steps.ts), so a
     row's press goes where the step is done rather than ticking it. -->
<script setup lang="ts">
import { Button, Icon, type IconName, Row, RowGroup, SegmentRing, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { SKIPPABLE, type StepId, type StepState } from "../tour/steps";
import { skipWords, stepWords } from "../tour/tourCopy";
import { useGettingStarted } from "./useGettingStarted";

const t = useT();
const router = useRouter();
const tour = useGettingStarted();

// `fill` for a page that gives it the width (a phone's Menu); a popover's list keeps its own.
const { fill = false } = defineProps<{ fill?: boolean }>();

const emit = defineEmits<{ done: [] }>();

const rows = computed(() => tour.progress.value.rows.map((row) => ({ ...row, words: stepWords(row.id) })));

const leadIcon = (state: StepState): IconName => (state === `done` ? `check-circle` : state === `skipped` ? `forward` : `circle`);

const go = (step: StepId): void => {
    emit(`done`);
    void router.push(stepWords(step).to);
};

const hide = (): void => {
    emit(`done`);
    void tour.hide();
};
</script>

<template>
    <div class="flex max-w-full flex-col gap-2 p-2" :class="fill ? 'w-full' : 'w-80'">
        <div class="flex items-center gap-2.5 px-2 pt-1.5">
            <SegmentRing
                :segments="tour.progress.value.total"
                :filled="tour.progress.value.settled"
                :size="22"
                :stroke="3"
                class="text-primary-500"
            />
            <div class="min-w-0 flex-1">
                <p class="text-sm font-semibold text-content">
                    {{ tour.finished.value ? t(`gettingStarted.panel.finishedTitle`) : t(`gettingStarted.panel.title`) }}
                </p>
                <p class="text-2xs text-muted">
                    {{ t(`gettingStarted.panel.progress`, { settled: tour.progress.value.settled, total: tour.progress.value.total }) }}
                </p>
            </div>
        </div>
        <p v-if="tour.finished.value" class="px-2 text-xs leading-relaxed text-muted">{{ t(`gettingStarted.panel.finishedLine`) }}</p>
        <RowGroup flat undivided>
            <Row
                v-for="row in rows"
                :key="row.id"
                :title="row.words.title"
                :description="row.state === 'current' ? row.words.line : row.state === 'skipped' ? t(`gettingStarted.panel.skipped`) : undefined"
                :selected="row.state === 'current'"
                :header-button="row.state !== 'done'"
                @header-click="go(row.id)"
            >
                <template #lead="{ iconClass }">
                    <Icon
                        :name="leadIcon(row.state)"
                        :class="[iconClass, row.state === 'done' ? 'text-success' : row.state === 'current' ? 'text-primary-400' : 'text-subtle']"
                    />
                </template>
                <template v-if="row.state === 'current' && SKIPPABLE.has(row.id)" #control>
                    <Button size="small" tier="quiet" @click="tour.skip(row.id)">{{ skipWords(row.id) }}</Button>
                </template>
            </Row>
        </RowGroup>
        <div class="flex items-center justify-end px-1 pb-1">
            <Button v-if="tour.finished.value" size="small" @click="hide">{{ t(`gettingStarted.panel.done`) }}</Button>
            <button v-else type="button" :class="ui.textButton({ tone: 'quiet' }, 'text-2xs')" @click="hide">
                {{ t(`gettingStarted.panel.hide`) }}
            </button>
        </div>
    </div>
</template>
