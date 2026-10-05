<!-- THIS COMPUTER'S SANDBOX, AND THIS WINDOW'S FOLDER GOING INTO IT, in the window's corner while the reader keeps
     working: the agent's house going up as the sandbox's setup really goes (AgentHouse.vue), then the folder's copy
     moving in; what it is doing in its own words, how far, and the one thing to do next whenever there is one. Every
     local window carries it while the sandbox is not ready (machineCard.ts says what each state is). Folds to a line,
     and the fold is remembered for what it showed; the folder's own button unfolds it again. -->
<script setup lang="ts">
import { Button, Icon, ProgressRing, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { localHost, type LocalMachineAction } from "../app/environments/localHost";
import AgentHouse from "./AgentHouse.vue";
import type { MachineCardAction } from "./machineCard";
import { useLocalProject } from "./useLocalProject";

const t = useT();
const router = useRouter();
const { card, minimized, fold, retryFolder, open, dismiss, pressed, actionFailure } = useLocalProject();
const project = localHost().project;

const tone = computed(() => card.value?.tone ?? `working`);
const percent = computed(() => card.value?.percent);
const detail = computed(() => actionFailure.value ?? card.value?.detail);
// The way to this computer's page is no way anywhere on that page itself.
const onDetails = computed(() => project !== undefined && router.currentRoute.value.path === project.detailsPath);
const actions = computed(() => (card.value?.actions ?? []).filter((action) => action !== `details` || !onDetails.value));

// What each press is called: the folder's "Try again" is the sandbox's word for it.
const label = (action: MachineCardAction): string => t(`local.machine.action.${action === `retryFolder` ? `retry` : action}`);

// What each press does: the app's verbs through the host, this computer's page in this window.
const APP_VERBS: ReadonlySet<MachineCardAction> = new Set<LocalMachineAction>([`signIn`, `startDocker`, `retry`, `log`, `start`, `recreate`]);
const isAppVerb = (action: MachineCardAction): action is LocalMachineAction => APP_VERBS.has(action);

const run = (action: MachineCardAction): void => {
    if (action === `details`) {
        if (project !== undefined) {
            void router.push(project.detailsPath);
        }
        return;
    }
    if (action === `open`) {
        void open();
        return;
    }
    if (action === `retryFolder`) {
        void retryFolder();
        return;
    }
    if (project !== undefined && isAppVerb(action)) {
        void pressed(() => project.act(action));
    }
};
</script>

<template>
    <div v-if="card !== undefined" class="w-full sm:w-[22rem]">
        <!-- Folded: one line, the ring for how far, and the way back to the whole card. -->
        <div v-if="minimized" class="flex items-center gap-2.5 rounded-lg border border-line-strong bg-card px-3 py-2 shadow-lg">
            <Icon v-if="tone === `ready`" name="check-circle" class="shrink-0 text-sm text-success" aria-hidden="true" />
            <Icon v-else-if="tone === `failed`" name="exclamation-circle" class="shrink-0 text-sm text-danger" aria-hidden="true" />
            <Icon v-else-if="tone === `waiting`" name="exclamation-circle" class="shrink-0 text-sm text-warning" aria-hidden="true" />
            <ProgressRing v-else-if="percent !== undefined" :value="percent" :size="16" class="text-primary-500" />
            <Icon v-else name="spinner" spin class="shrink-0 text-sm text-primary-500" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate text-xs text-content">{{ card.short }}</span>
            <span v-if="percent !== undefined" class="shrink-0 text-2xs tabular-nums text-muted">{{ t(`local.project.percent`, { percent }) }}</span>
            <Button v-if="actions[0] !== undefined" size="small" class="-my-1 shrink-0" :label="label(actions[0])" @click="run(actions[0])" />
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
                <AgentHouse :stage="card.stage" :paused="tone === `waiting`" :failed="tone === `failed`" class="mx-auto h-auto max-h-28 w-full" />
            </div>

            <div class="p-3">
                <div class="flex items-start gap-2">
                    <p class="min-w-0 flex-1 break-words text-xs font-medium text-content">{{ card.title }}</p>
                    <button
                        type="button"
                        :class="ui.iconButton(`-my-1 shrink-0`)"
                        v-tooltip.top="t(`local.project.hide`)"
                        :aria-label="t(`local.project.hide`)"
                        @click="fold(true)"
                    >
                        <Icon name="chevron-down" class="text-xs" />
                    </button>
                    <button v-if="tone === `ready`" type="button" :class="ui.iconButton(`-my-1 shrink-0`)" :aria-label="t(`ui.action.dismiss`)" @click="dismiss">
                        <Icon name="times" class="text-xs" />
                    </button>
                </div>
                <p v-if="detail" class="mt-0.5 line-clamp-3 break-words text-2xs" :class="tone === `failed` || actionFailure ? `text-danger` : `text-muted`">
                    {{ detail }}
                </p>
                <p v-if="card.folderNote" class="mt-1 break-words text-2xs text-subtle">{{ card.folderNote }}</p>

                <!-- How far: the setup's own estimate, held back from 100 until it says it is done. -->
                <template v-if="percent !== undefined">
                    <div
                        class="mt-2.5 h-1 overflow-hidden rounded-full bg-line"
                        role="progressbar"
                        :aria-valuenow="percent"
                        aria-valuemin="0"
                        aria-valuemax="100"
                        :aria-label="card.title"
                    >
                        <div class="h-full rounded-full bg-primary-500 transition-[width] duration-700 ease-smooth" :style="{ width: `${percent}%` }"></div>
                    </div>
                    <div class="mt-1.5 flex items-center gap-3 text-2xs">
                        <span class="min-w-0 flex-1 truncate text-subtle" v-tooltip.top="card.step">{{ card.step }}</span>
                        <span class="shrink-0 tabular-nums text-muted">{{ t(`local.project.percent`, { percent }) }}</span>
                    </div>
                </template>

                <!-- The one thing to do next, as the primary press; anything beside it is a secondary one away. -->
                <div v-if="actions.length > 0" class="mt-3 flex items-center justify-end gap-1">
                    <Button
                        v-for="(action, at) in [...actions].reverse()"
                        :key="action"
                        size="small"
                        :severity="at === actions.length - 1 ? undefined : `secondary`"
                        :text="at !== actions.length - 1"
                        :label="label(action)"
                        @click="run(action)"
                    />
                </div>
            </div>
        </div>
    </div>
</template>
