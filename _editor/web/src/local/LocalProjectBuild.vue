<!-- A FOLDER'S SANDBOX BEING BUILT, in the corner of its window while the reader keeps working: the agent's house going
     up as the setup really goes (AgentHouse.vue), what it is doing in its own words, how far and how long, and the one
     thing to do next once there is one. Folds to a line; the folder's own button unfolds it again. -->
<script setup lang="ts">
import { Button, Icon, ProgressRing, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { localHost } from "../app/environments/localHost";
import AgentHouse from "./AgentHouse.vue";
import { houseStageOf } from "./agentHouse";
import { remainingWords, stageHeadline } from "./projectWords";
import { useLocalProject } from "./useLocalProject";

const t = useT();
const router = useRouter();
const { build, minimized, fold, retry, retryFailure } = useLocalProject();
const project = localHost().project;

const stage = computed(() => (build.value === undefined ? `plan` : houseStageOf(build.value)));
const state = computed(() => build.value?.state ?? `building`);
const name = computed(() => build.value?.name ?? ``);
const ended = computed(() => state.value === `ready` || state.value === `failed` || state.value === `stopped`);

const title = computed(() => t(`local.project.${state.value}`, { name: name.value }));
// The line under the title: the house's own words while it goes up, then what the end means.
const detail = computed(() => {
    switch (state.value) {
        case `building`:
            return stageHeadline(stage.value);
        case `waiting`:
            return t(`local.project.waitingDetail`);
        case `ready`:
            return t(`local.project.readyDetail`);
        case `failed`:
            return retryFailure.value ?? build.value?.error;
        case `stopped`:
            return retryFailure.value;
        default:
            return undefined;
    }
});
// The folded line's words: the folder while it builds, and the shortest form of anything else.
const folded = computed(() => {
    if (state.value === `ready`) {
        return t(`local.project.readyShort`, { name: name.value });
    }
    return state.value === `building` ? name.value : title.value;
});
const remaining = computed(() => remainingWords(build.value?.remainingMs));
const percent = computed(() => build.value?.percent ?? 0);

const open = (): void => void project?.open();
const dismiss = (): void => project?.dismiss();
const details = (): void => {
    if (project !== undefined) {
        void router.push(project.detailsPath);
    }
};
</script>

<template>
    <div v-if="build !== undefined" class="w-full sm:w-[22rem]">
        <!-- Folded: one line, the ring for how far, and the way back to the whole card. -->
        <div v-if="minimized" class="flex items-center gap-2.5 rounded-lg border border-line-strong bg-card px-3 py-2 shadow-lg">
            <Icon v-if="state === `ready`" name="check-circle" class="shrink-0 text-sm text-success" aria-hidden="true" />
            <Icon v-else-if="ended" name="exclamation-circle" class="shrink-0 text-sm text-warning" aria-hidden="true" />
            <ProgressRing v-else :value="percent" :size="16" class="text-primary-500" />
            <span class="min-w-0 flex-1 truncate text-xs text-content">{{ folded }}</span>
            <span v-if="state === `building`" class="shrink-0 text-2xs tabular-nums text-muted">{{ t(`local.project.percent`, { percent }) }}</span>
            <Button v-if="state === `ready`" size="small" class="-my-1 shrink-0" :label="t(`local.project.open`)" @click="open" />
            <button
                type="button"
                :class="ui.iconButton(`-my-1 shrink-0`)"
                v-tooltip.top="t(`local.project.show`)"
                :aria-label="t(`local.project.show`)"
                @click="fold(false)"
            >
                <Icon name="chevron-up" class="text-xs" />
            </button>
        </div>

        <div v-else class="overflow-hidden rounded-lg border border-line-strong bg-card shadow-lg">
            <!-- The house, on its own ground: the card's picture, drawn by the setup's real progress. -->
            <div class="border-b border-line bg-canvas px-4 pb-1.5 pt-4">
                <AgentHouse
                    :stage="stage"
                    :progress="build.phaseProgress"
                    :paused="state === `waiting`"
                    :failed="state === `failed` || state === `stopped`"
                    class="mx-auto h-auto max-h-28 w-full"
                />
            </div>

            <div class="p-3">
                <div class="flex items-start gap-2">
                    <p class="min-w-0 flex-1 break-words text-xs font-medium text-content">{{ title }}</p>
                    <button
                        type="button"
                        :class="ui.iconButton(`-my-1 shrink-0`)"
                        v-tooltip.top="t(`local.project.hide`)"
                        :aria-label="t(`local.project.hide`)"
                        @click="fold(true)"
                    >
                        <Icon name="chevron-down" class="text-xs" />
                    </button>
                    <button v-if="ended" type="button" :class="ui.iconButton(`-my-1 shrink-0`)" :aria-label="t(`ui.action.dismiss`)" @click="dismiss">
                        <Icon name="times" class="text-xs" />
                    </button>
                </div>
                <p v-if="detail" class="mt-0.5 line-clamp-3 break-words text-2xs" :class="state === `failed` || state === `stopped` ? `text-danger` : `text-muted`">
                    {{ detail }}
                </p>

                <!-- How far, and how long: the bar is the setup's own estimate, held back from 100 until it says it is done. -->
                <template v-if="state === `building`">
                    <div
                        class="mt-2.5 h-1 overflow-hidden rounded-full bg-line"
                        role="progressbar"
                        :aria-valuenow="percent"
                        aria-valuemin="0"
                        aria-valuemax="100"
                        :aria-label="title"
                    >
                        <div class="h-full rounded-full bg-primary-500 transition-[width] duration-700 ease-smooth" :style="{ width: `${percent}%` }"></div>
                    </div>
                    <div class="mt-1.5 flex items-center gap-3 text-2xs">
                        <span class="min-w-0 flex-1 truncate text-subtle" v-tooltip.top="build.step">{{ build.step }}</span>
                        <span v-if="remaining" class="shrink-0 text-subtle">{{ remaining }}</span>
                        <span class="shrink-0 tabular-nums text-muted">{{ t(`local.project.percent`, { percent }) }}</span>
                    </div>
                </template>

                <!-- The one thing to do next, as the primary press; a failure's whole story is a secondary one away. -->
                <div v-if="state !== `building`" class="mt-3 flex items-center justify-end gap-1">
                    <Button v-if="state === `waiting`" size="small" :label="t(`local.project.review`)" @click="details" />
                    <Button v-if="state === `failed`" size="small" severity="secondary" :text="true" :label="t(`local.project.details`)" @click="details" />
                    <Button v-if="state === `failed` || state === `stopped`" size="small" :label="t(`local.project.retry`)" @click="retry" />
                    <Button v-if="state === `ready`" size="small" :label="t(`local.project.open`)" @click="open" />
                </div>
            </div>
        </div>
    </div>
</template>
