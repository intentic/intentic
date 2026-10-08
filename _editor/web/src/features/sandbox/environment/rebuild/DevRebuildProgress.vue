<script setup lang="ts">
import { Code, commandLang, formatElapsed, Notice, type NoticeModel } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { DEV_REBUILD_STEPS } from "./devRebuildStages";
import StagedProgress from "../../progress/StagedProgress.vue";
import type { ProgressStatus } from "../../progress/stagedProgress";
import { type DevRebuildRun, outOfContact, rebuildRunning } from "./useDevRebuild";
import { useT } from "@intentic/ui/i18n";

// A REBUILD DRAWN AS THE THREE THINGS IT DOES (<StagedProgress>, which a device's update shares), with what only a
// rebuild has to say beside it: what it costs the reader right now, how it ended, and where its ending is written
// once this page can no longer read it. The log opens itself on a failure.

const t = useT();

const props = defineProps<{
    run: DevRebuildRun;
    /** Seconds this run has been going; undefined for one adopted mid-flight, whose start nothing here saw. */
    elapsed: number | undefined;
    /** Where the machine wrote the whole thing, for a reader whose rebuild never came back. */
    logPath: string;
    /** The sandbox's name as `ic` knows it on that machine, for the lines that read the outcome there. */
    slug: string;
}>();

defineEmits<{ dismiss: [] }>();

const live = computed(() => rebuildRunning(props.run.phase));
const now = useNow(() => live.value);

// The restart step gone unheard-from past the patience a swap gets. From here the card stops promising a reconnect it
// cannot see coming and says where the ending is written instead, while the follow keeps asking underneath.
const unheard = computed(() => outOfContact(props.run, now.value));

// The status the steps are drawn in: not known to be going nor known to have stopped is the step this page lost sight
// of; where it got to and stopped is not finished, and not still going either.
const status = computed<ProgressStatus>(() => {
    if (props.run.phase === `done`) {
        return `done`;
    }
    if (unheard.value) {
        return `unheard`;
    }
    return live.value ? `running` : `stopped`;
});

// A finished rebuild finished every step, whichever marker its last tail happened to end on.
const stage = computed(() => (props.run.phase === `done` ? `swap` : props.run.stage));

const elapsedLabel = computed(() => (props.elapsed === undefined ? undefined : formatElapsed(props.elapsed)));

// What the step is on this second, in the tool's own words: the package turbo is compiling, docker's layer count, the
// sentence ic printed. Only ever beside the running step, since it describes this instant and nothing else.
const detail = computed(() => {
    const { layers, detail: said } = props.run;
    if (props.run.stage === `image` && layers !== undefined) {
        return t(`sandbox.devRebuildProgress.layerOf`, { done: layers.done, total: layers.total });
    }
    return said;
});

const heading = computed(() => t(`sandbox.useDevRebuild.rebuildingFromCheckout`));

// The one sentence about THIS sandbox, which flips at the swap: up to it the build costs the reader nothing, and from
// it their workspace is the thing that went away.
const cost = computed(() => {
    if (!live.value || unheard.value) {
        return undefined;
    }
    return props.run.stage === `swap` ? t(`sandbox.devRebuildProgress.restartingOnNewImage`) : t(`sandbox.devRebuildProgress.keepsWorking`);
});

const done = computed(() =>
    props.run.phase === `done`
        ? elapsedLabel.value === undefined
            ? t(`sandbox.devRebuildProgress.rebuiltFewMinutes`)
            : t(`sandbox.devRebuildProgress.rebuiltIn`, { elapsed: elapsedLabel.value })
        : undefined,
);

const failure = computed<NoticeModel | undefined>(() => {
    if (props.run.phase === `failed`) {
        const title =
            props.run.exitCode === undefined
                ? t(`sandbox.devRebuildProgress.deviceDidntRun`)
                : t(`sandbox.devRebuildProgress.failedOnDevice`, { code: props.run.exitCode });
        return { tone: `warning`, title, ...(props.run.trouble === undefined ? {} : { detail: props.run.trouble }) };
    }
    if (props.run.phase === `lost` && unheard.value) {
        const said = [t(`sandbox.devRebuildProgress.lostContactGaveUp`), props.run.trouble].filter((line) => line !== undefined).join(`\n`);
        return { tone: `warning`, title: t(`sandbox.devRebuildProgress.lostContact`), detail: said };
    }
    if (props.run.phase === `lost`) {
        return {
            tone: `warning`,
            title: t(`sandbox.devRebuildProgress.rebuildStoppedReportingNever`),
            detail: props.run.trouble ?? t(`sandbox.devRebuildProgress.logSilent`),
        };
    }
    return undefined;
});

// Still following, still unheard-from: the same words while the polls go on, and no log thrown open — this is not a
// failure until something says so.
const adrift = computed<NoticeModel | undefined>(() =>
    live.value && unheard.value
        ? { tone: `warning`, title: t(`sandbox.devRebuildProgress.lostContact`), detail: t(`sandbox.devRebuildProgress.lostContactRetrying`) }
        : undefined,
);
const notice = computed(() => failure.value ?? adrift.value);

// WHERE THE ENDING IS, once this page cannot read it: the build's own log, which `ic` finishes with its verdict on the
// swap; the new container's log, which says why it would not come up; and `ic`'s diagnosis of both. All on the machine
// that runs the rebuild, which wrote the ending down whether or not anyone here was listening — there is no other way
// to it, since the machine agent reaches this sandbox through the same daemon. Spelled bare, as deviceFallback.ts
// spells them: ic's installer puts it on the PATH.
const outcomeCommands = computed(() => [`tail -n 40 ${props.logPath}`, `ic sandbox logs ${props.slug}`, `ic sandbox doctor ${props.slug}`].join(`\n`));

// A docker layer builds for minutes without printing anything, so a still pane is not evidence of a stuck build — but
// after a while it is worth saying which of the two this is, rather than leaving the reader to guess.
const QUIET_AFTER_S = 90;
const quiet = computed(() => {
    const seconds = props.run.quietFor ?? 0;
    return props.run.phase === `building` && !unheard.value && seconds > QUIET_AFTER_S
        ? t(`sandbox.devRebuildProgress.quietFor`, { minutes: Math.round(seconds / 60) })
        : undefined;
});

// A read that failed while the build carries on regardless: the machine's own words, not a verdict on the rebuild.
const hiccup = computed(() => (live.value ? props.run.trouble : undefined));

const showLog = ref(false);
// A failure is the one state where nobody has to ask: the lines ARE the answer, so they are already open. Immediate,
// because a card drawn onto a rebuild that failed before it mounted owes the reader the same thing.
watch(
    failure,
    (bad) => {
        if (bad !== undefined) {
            showLog.value = true;
        }
    },
    { immediate: true },
);
</script>

<template>
    <StagedProgress
        v-model:log="showLog"
        :heading="heading"
        :elapsed="elapsed"
        :steps="DEV_REBUILD_STEPS"
        :stage="stage"
        :stage-at="run.stageAt"
        :ended-at="run.endedAt"
        :fraction="run.fraction"
        :status="status"
        :live="live"
        :detail="detail"
        :lines="run.lines"
        :empty-log="t(`sandbox.devRebuildProgress.waitingFirstLineDevice`)"
        :show-log-label="t(`sandbox.devRebuildProgress.showLog`)"
        :hide-log-label="t(`sandbox.devRebuildProgress.hideLog`)"
        @dismiss="$emit(`dismiss`)"
    >
        <p v-if="cost" class="text-2xs text-muted">{{ cost }}</p>

        <div v-if="notice" class="flex flex-col gap-1.5">
            <Notice :of="notice" class="text-2xs" />
            <!-- Under the notice, not inside it: the notice is the reason, these are the way to the answer. -->
            <Code
                v-if="unheard"
                :code="outcomeCommands"
                :lang="commandLang(`unix`)"
                :label="t(`sandbox.devRebuildProgress.outcomeOnMachine`)"
                :wrap="true"
            />
        </div>
        <p v-else-if="done" class="flex items-center gap-2 text-2xs text-muted">
            <Icon name="check-circle" class="shrink-0 text-success" />
            <span>{{ done }}</span>
        </p>

        <p v-if="quiet" class="text-2xs text-subtle">{{ quiet }}</p>
        <p v-if="hiccup" class="text-2xs text-subtle">{{ t(`sandbox.devRebuildProgress.cantReadLogAt`, { hiccup }) }}</p>

        <!-- The whole thing outlives this card, so where it lives is worth keeping beside the tail it shows. -->
        <template #log-footer>
            <p class="text-2xs text-subtle">
                {{ t(`sandbox.devRebuildProgress.fullOutputIn`) }} <span class="font-mono">{{ logPath }}</span>
                {{ t(`sandbox.devRebuildProgress.onDevice`) }}
            </p>
        </template>
    </StagedProgress>
</template>
