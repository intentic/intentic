<!-- One place programs run, as a Run lane: the sandbox or one of the owner's computers, whether it can take a run now,
     what runs there, and what can be started there. -->
<script setup lang="ts">
import { Icon, Picker, type PickerGroup, RowGroup, RowNote, toneDot, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, inject, ref } from "vue";
import { RouterLink } from "vue-router";
import { here, page } from "../../lib/routes/links";
import { RUN_ACTIONS } from "./runActions";
import { laneRunning, type RunBlock, type RunLane } from "./runLanes";
import RunItemRow from "./RunItemRow.vue";
import { SANDBOX } from "./runRows";

const t = useT();

const { lane, showRepo } = defineProps<{
    lane: RunLane;
    /** Every repository is shown: rows name theirs, and a long list of what could start folds. */
    showRepo: boolean;
}>();

const actions = inject(RUN_ACTIONS)!;

const inSandbox = computed(() => lane.place === SANDBOX);
const title = computed(() => (inSandbox.value ? t(`run.view.sandbox`) : lane.place));

// Why a computer cannot take a run, each said by its own literal key so the catalogs can see every one is used.
const blockWords = (block: RunBlock): string => {
    if (block === `offline`) {
        return t(`run.view.offlineShort`);
    }
    return block === `agentTooOld` ? t(`run.view.agentTooOldShort`) : t(`run.view.switchOffShort`);
};

const running = computed(() => laneRunning(lane));
// Beside the name: whether it can take a run, and how many programs run there.
const note = computed(() => {
    const where = inSandbox.value ? t(`run.view.sandboxNote`) : lane.block === undefined ? t(`run.view.online`) : blockWords(lane.block);
    return running.value === 0 ? where : `${where} · ${t(`run.view.runningCount`, { count: running.value }, running.value)}`;
});
// Filled when it can take a run, a warning while connected but refusing, a hollow ring while asleep: shape carries the
// difference as well as hue, since a skin's muted tones are close at 6px.
const DOT = `size-1.5 shrink-0 rounded-full`;
const dot = computed(() => {
    if (lane.block === `offline`) {
        return `${DOT} border border-subtle`;
    }
    return toneDot(lane.block === undefined ? `success` : `warning`, DOT);
});

// What could start here, folded past a few while every repository is shown: what runs leads, the rest is on request.
const FOLD = 4;
const unfolded = ref(false);
const idle = computed(() => (lane.block !== undefined ? [] : lane.idle));
const shownIdle = computed(() => (showRepo && !unfolded.value ? idle.value.slice(0, FOLD) : idle.value));
const hiddenIdle = computed(() => idle.value.length - shownIdle.value.length);
// On a computer that cannot take a run now, what is waiting for it is a count, not a column of disabled presses.
const waiting = computed(() => (lane.block === undefined ? 0 : lane.idle.length));
const empty = computed(() => lane.active.length === 0 && idle.value.length === 0 && waiting.value === 0);

// "Run…": any target that carries a build to a computer, started on this one, whichever computer its file names.
const SEP = `\n`;
const runnable = computed<PickerGroup[]>(() => {
    const repos = [...new Set(lane.runnable.map((target) => target.repo))];
    return repos.map((repo): PickerGroup => {
        const options = lane.runnable
            .filter((target) => target.repo === repo)
            .map((target) => ({ value: `${repo}${SEP}${target.row.name}`, label: target.row.name, description: target.row.description, mono: true }));
        return showRepo ? { label: repo, options } : { options };
    });
});
const runPicked = (value: string | undefined): void => {
    const [repo, target] = value?.split(SEP) ?? [];
    if (repo !== undefined && target !== undefined) {
        actions.run(repo, target, lane.place);
    }
};
</script>

<template>
    <RowGroup>
        <template #label>
            <span class="inline-flex items-center gap-2"><span :class="dot" aria-hidden="true" />{{ title }}</span>
        </template>
        <template #info>
            <span class="ml-2 min-w-0 truncate text-2xs text-subtle">{{ note }}</span>
        </template>
        <template v-if="(lane.block === undefined && lane.runnable.length > 0) || (lane.block !== undefined && lane.block !== `offline`)" #actions>
            <Picker
                v-if="lane.block === undefined"
                :model-value="undefined"
                :options="runnable"
                variant="ghost"
                :placeholder="t(`run.view.runHere`)"
                :aria-label="t(`run.view.runHereLabel`, { device: lane.place })"
                :header="t(`run.view.runHereLabel`, { device: lane.place })"
                @update:model-value="runPicked"
            >
                <template #icon><Icon name="play" class="text-2xs" /></template>
            </Picker>
            <RouterLink v-else :to="here(page.capabilities(lane.place))" :class="ui.textButton()">{{ t(`run.view.openCard`) }}</RouterLink>
        </template>

        <RunItemRow v-for="item in lane.active" :key="item.key" :place="lane.place" :block="lane.block" :item="item" :show-repo="showRepo" />
        <RunItemRow v-for="item in shownIdle" :key="item.key" :place="lane.place" :block="lane.block" :item="item" :show-repo="showRepo" />
        <RowNote v-if="hiddenIdle > 0" variant="action" icon="chevron-down" :label="t(`run.view.showMore`, { count: hiddenIdle })" @click="unfolded = true" />
        <RowNote v-if="lane.listError !== undefined" icon="exclamation-triangle" tone="warning">
            {{ t(`run.view.listFailed`, { device: lane.place, reason: lane.listError }) }}
        </RowNote>
        <RowNote v-if="waiting > 0">{{ t(`run.view.waiting`, { count: waiting }, waiting) }}</RowNote>
        <RowNote v-else-if="empty && lane.listError === undefined" variant="empty">{{ t(`run.view.nothingHere`) }}</RowNote>
    </RowGroup>
</template>
