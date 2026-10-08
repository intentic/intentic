<script setup lang="ts">
import { CAPABILITY_CATALOG, localModelGb } from "@intentic/capability-catalog";
import { type LocalModelFitResponse, LOCAL_MODEL_WINDOW_DEFAULT, type CapabilitySummary } from "@intentic/sandbox-contract";
import { Button, Icon, type IconName, Row, RowNote, SkeletonSnapshot, StatusBadge, type StatusVariant, ui, vSkeletonSource } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { useCapabilities } from "../../capabilities/connect/useCapabilities";
import { suggestName } from "../../capabilities/model/tiles";
import { useT } from "@intentic/ui/i18n";

// The machine the reader already owns, inside the Local models panel (LocalModelsPanel). Two rungs and no arithmetic: one
// that is ready in a minute and says plainly what it is good for, one that is the most this box can hold. Everything
// quoted here is measured in the sandbox (memory, weights on disk) rather than assumed from a table. These run on the
// sandbox's CPU; a GPU model is a server on the host, which the panel offers beside this lane.
//
// Each rung reads in three steps, most important first: its name and what it is for, its state or the one button that
// takes it, then its costs as short facts. A daemon sentence about what went wrong gets a line of its own under that,
// never the header: squeezed beside the name it truncated into a run-on nobody could act on.
//
// A rung that has been taken reports instead of offering: the add writes a manifest entry in seconds and the server
// then loads for minutes, so the press that looks finished is the start of the wait, not the end of it.
//
// Drawn as rows of the panel's card, hairline-divided like the rows above it, never as cards of its own on that card.

const t = useT();

const { fit } = defineProps<{ fit: LocalModelFitResponse | undefined }>();
const emit = defineEmits<{ ready: [provider: string]; stopPrefetch: [] }>();

const { capabilities, add } = useCapabilities();
const card = CAPABILITY_CATALOG.find((entry) => entry.id === `localmodel`)!;

const installed = computed(() => (capabilities.value ?? []).filter((entry) => entry.kind === `localmodel`));

// Adding is a stream of log frames; the last one is what the lane shows, since it is the line that says what happens
// next ("downloading in the background", "starting llama-server").
const busy = ref<string | undefined>(undefined);
const note = ref<string | undefined>(undefined);
const failure = ref<string | undefined>(undefined);

const gb = (bytes: number) => localModelGb(bytes);

const optionOf = (model: string | undefined) => fit?.options.find((option) => option.model === model);

// Matched on the weights, never on the entry's id: two entries naming one model are not two models, they are one
// server slot with a loser, so the second is a dead row in the model picker.
const installedFor = (model: string): CapabilitySummary | undefined => installed.value.find((entry) => entry.config[`model`] === model);

// What each offer costs, as facts rather than a sentence: the download only where there is one, the memory it holds
// while it runs, and its conversation window. A taken rung keeps the last two; its download is behind it.
const factsOf = (model: string, context: string, taken: boolean): string[] => {
    const option = optionOf(model);
    if (option === undefined) {
        return [];
    }
    const window = option.windows.find((entry) => entry.tokens === Number(context));
    const facts: string[] = [];
    if (!taken) {
        facts.push(
            option.held ? t(`connect.localModelLane.factDownloaded`) : t(`connect.localModelLane.factDownload`, { size: gb(option.weightsBytes) }),
        );
    }
    if (window !== undefined) {
        facts.push(t(`connect.localModelLane.factMemory`, { total: gb(window.totalBytes) }));
    }
    facts.push(t(`connect.localModelLane.factWindow`, { window: Number(context) / 1024 }));
    return facts;
};

// The instant rung writes commit messages and titles and never runs a chat: the daemon refuses a turn on it and the
// picker does not offer it for one, so this lane never hands it on as the model to chat with.
const quickJobsOnly = (model: string): boolean => optionOf(model)?.tier === `instant`;

// The model this lane just started, watched until the daemon says it serves. Held here rather than announced on the
// add's return because the add returns while llama-server is still loading its weights, and a chat opened then fails.
const starting = ref<string | undefined>(undefined);
watch(
    () => (starting.value === undefined ? undefined : installedFor(starting.value)),
    (entry) => {
        if (entry === undefined || entry.status.state === `pending`) {
            return;
        }
        const model = starting.value;
        starting.value = undefined;
        // The apply's last log line was about the wait; the rung's own status has taken that over by now.
        note.value = undefined;
        if (entry.status.state === `active` && model !== undefined && !quickJobsOnly(model)) {
            emit(`ready`, `endpoint/${entry.id}`);
        }
    },
);

// A taken rung's state as a short word in a pill; the daemon's own sentence, where it has one worth reading, goes under
// the facts (rungDetail).
const rungStatus = (entry: CapabilitySummary): { variant: StatusVariant; label: string; icon?: IconName } => {
    const { state } = entry.status;
    if (state === `active`) {
        return { variant: `success`, label: t(`connect.localModelLane.ready`) };
    }
    // `inactive` cannot reach this lane (nothing here switches a model off), so it reads as the wait it most resembles.
    return state === `error`
        ? { variant: `danger`, label: t(`connect.localModelLane.statusFailed`) }
        : { variant: `neutral`, label: t(`ui.status.starting`), icon: `spinner` };
};

// A serving row's sentence ("<weights> · <window>") is already said by the rung's name and facts, so it gets no line.
// Anything else the daemon says (a pending step, a failure) is read whole.
const rungDetail = (entry: CapabilitySummary): { tone: `warning` | `danger` | `muted`; text: string } | undefined => {
    const { state, detail } = entry.status;
    if (detail === undefined || detail === `` || state === `active`) {
        return undefined;
    }
    return { tone: state === `error` ? `danger` : `muted`, text: detail };
};

const DETAIL_TONE = { warning: `text-warning`, danger: `text-danger`, muted: `text-subtle` } as const;
const DETAIL_ICON: Record<`warning` | `danger` | `muted`, IconName> = {
    warning: `exclamation-triangle`,
    danger: `exclamation-circle`,
    muted: `spinner`,
};

const addModel = async (model: string, context: string): Promise<void> => {
    if (busy.value !== undefined || installedFor(model) !== undefined) {
        return;
    }
    busy.value = model;
    failure.value = undefined;
    note.value = undefined;
    const id = suggestName(card, installed.value, optionOf(model)?.label);
    try {
        await add({ id, kind: `localmodel`, config: { model, context } }, (line) => {
            if (typeof line[`message`] === `string`) {
                note.value = line[`message`] as string;
            }
        });
        starting.value = model;
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        busy.value = undefined;
    }
};

// What the machine has, as a fact with a glyph rather than a paragraph.
const memoryFact = computed(() =>
    fit === undefined
        ? undefined
        : fit.memoryCapped
          ? t(`connect.localModelLane.memoryCapped`, { memory: gb(fit.memoryBytes) })
          : t(`connect.localModelLane.memoryMachine`, { memory: gb(fit.memoryBytes) }),
);
// One quieter line under the fact: what the offers were sized against (the free memory, so a model offered here runs at
// full speed). An older daemon sized against the total and says nothing of it, so neither does this.
const machineHint = computed(() =>
    fit?.fullSpeedBytes === undefined ? undefined : t(`connect.localModelLane.sizedForMemory`, { free: gb(fit.fullSpeedBytes) }),
);

// Whether a rung has anything for its second block; an empty one would still spend the row's gap.
const hasBelow = (rung: { model: string; warn: string | undefined; detail: unknown; installed: CapabilitySummary | undefined }): boolean =>
    rung.warn !== undefined ||
    rung.detail !== undefined ||
    (quickJobsOnly(rung.model) && rung.installed?.status.state === `active`) ||
    (rung.installed === undefined && fit?.prefetch.state === `downloading` && fit.prefetch.model === rung.model);

const nothingFits = computed(() => fit !== undefined && fit.instant === undefined && fit.best === undefined);
// Two offers that name the same model collapse into one: a small machine would otherwise be handed the same row twice.
const bestIsInstant = computed(() => fit?.best !== undefined && fit.best.model === fit.instant?.model);

// The rungs in reading order, each carrying whatever entry already holds its weights so the row below decides between
// an offer and a report once, not twice.
const rungs = computed(() => {
    const offers: {
        key: string;
        model: string;
        context: string;
        icon: IconName;
        iconClass: string;
        badge: string;
        badgeVariant: StatusVariant;
        action: string;
        pitch: string;
        warn: string | undefined;
    }[] = [];
    if (fit?.instant !== undefined && !bestIsInstant.value) {
        offers.push({
            key: `instant`,
            model: fit.instant.model,
            context: fit.instant.context,
            icon: `bolt`,
            iconClass: `text-warning`,
            badge: t(`connect.localModelLane.quickJobsOnly`),
            badgeVariant: `neutral`,
            action: t(`connect.localModelLane.startNow`),
            pitch: t(`connect.localModelLane.quickJobsPitch`),
            warn: undefined,
        });
    }
    if (fit?.best !== undefined) {
        offers.push({
            key: `best`,
            model: fit.best.model,
            context: fit.best.context,
            icon: `cpu`,
            iconClass: `text-link`,
            badge: t(`connect.localModelLane.bestHere`),
            badgeVariant: `primary`,
            action: t(`connect.localModelLane.runIt`),
            pitch: t(`connect.localModelLane.bestPitch`),
            // A window under the contract's default cannot hold one agent turn, and the offer has to say so.
            warn: Number(fit.best.context) < Number(LOCAL_MODEL_WINDOW_DEFAULT) ? t(`connect.localModelLane.windowUnderFloor`) : undefined,
        });
    }
    return offers.map((offer) => {
        const taken = installedFor(offer.model);
        return {
            ...offer,
            installed: taken,
            status: taken === undefined ? undefined : rungStatus(taken),
            detail: taken === undefined ? undefined : rungDetail(taken),
            facts: factsOf(offer.model, offer.context, taken !== undefined),
        };
    });
});
</script>

<template>
    <div>
        <!-- Nothing is offered before the machine has answered; a skeleton beats a number we would have to take back. The
             lane as this machine last drew it, once it has been seen; until then the words. -->
        <SkeletonSnapshot v-if="fit === undefined" of="connect.local-model" :label="t(`connect.localModelLane.measuring`)">
            <p class="flex items-center gap-1.5 px-4 py-3.5 text-xs text-subtle">
                <Icon name="spinner" spin />{{ t(`connect.localModelLane.measuring`) }}
            </p>
        </SkeletonSnapshot>

        <!-- One element, so its imprint is the whole lane; its parts divided as the rows of the card it sits in. -->
        <div v-else v-skeleton-source="`connect.local-model`" class="divide-y divide-line-subtle">
            <RowNote variant="block">
                <div class="flex flex-col gap-1">
                    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                        <span class="flex items-center gap-1.5"><Icon name="database" class="text-2xs text-subtle" />{{ memoryFact }}</span>
                    </div>
                    <p v-if="machineHint" class="text-2xs text-subtle">{{ machineHint }}</p>
                </div>
            </RowNote>

            <!-- llama-server is baked into the standard image, so this is the dev-run and core-image case, not the usual one. -->
            <p v-if="!fit.serverReady" :class="ui.emptyState(`px-4 py-3.5 text-left`)">{{ t(`connect.localModelLane.needsRebuild`) }}</p>

            <p v-else-if="nothingFits" :class="ui.emptyState(`px-4 py-3.5 text-left`)">
                {{
                    fit.fullSpeedBytes === undefined
                        ? t(`connect.localModelLane.nothingFits`, { memory: gb(fit.memoryBytes) })
                        : t(`connect.localModelLane.nothingRunsWhole`, { free: gb(fit.fullSpeedBytes) })
                }}
            </p>

            <Row v-for="rung in rungs" v-else :key="rung.key" indent>
                <template #lead="{ iconClass }">
                    <Icon :name="rung.icon" class="shrink-0" :class="[iconClass, rung.iconClass]" />
                </template>
                <template #title>
                    <span class="flex flex-wrap items-center gap-2">
                        {{ optionOf(rung.model)?.label }}
                        <StatusBadge :variant="rung.badgeVariant" :label="rung.badge" size="xs" />
                    </span>
                </template>
                <!-- What it is for, then what it costs as short facts, read as one block under the name. -->
                <template #description>
                    <span class="block">{{ rung.pitch }}</span>
                    <span class="mt-0.5 block text-2xs tabular-nums text-subtle">{{ rung.facts.join(` · `) }}</span>
                </template>
                <template #control>
                    <!-- Taken: where it has got to, in place of a button whose second press would write a second entry and
                         leave this one without the machine's single server slot. -->
                    <StatusBadge v-if="rung.status" :variant="rung.status.variant" dot>
                        <Icon v-if="rung.status.icon" :name="rung.status.icon" spin class="text-2xs" />{{ rung.status.label }}
                    </StatusBadge>
                    <Button
                        v-else
                        size="small"
                        :label="rung.action"
                        :loading="busy === rung.model"
                        :disabled="busy !== undefined"
                        @click="addModel(rung.model, rung.context)"
                    />
                </template>
                <!-- Only what needs a second look: a warning, the daemon's own words, where to use it, a download running. -->
                <template v-if="hasBelow(rung)" #below>
                    <div class="flex flex-col items-start gap-1.5">
                        <p v-if="rung.warn" class="flex items-start gap-1.5 text-2xs text-warning">
                            <Icon name="exclamation-triangle" class="mt-px shrink-0 text-2xs" /><span>{{ rung.warn }}</span>
                        </p>
                        <!-- The daemon's own words, on a line of their own, with the place its advice points at. -->
                        <p v-if="rung.detail" class="flex items-start gap-1.5 text-2xs" :class="DETAIL_TONE[rung.detail.tone]">
                            <Icon :name="DETAIL_ICON[rung.detail.tone]" :spin="rung.detail.tone === `muted`" class="mt-px shrink-0 text-2xs" />
                            <span class="min-w-0"
                                >{{ rung.detail.text }}
                                <RouterLink
                                    v-if="rung.detail.tone !== `muted`"
                                    to="/capabilities/localmodel"
                                    :class="ui.textButton({ size: `xs` }, `ml-1`)"
                                    >{{ t(`connect.localModelLane.openSettings`) }}<Icon name="arrow-right" class="text-2xs"
                                /></RouterLink>
                            </span>
                        </p>
                        <!-- Served and helper-only: where it earns its keep is a settings list, not a chat, so that is where this points. -->
                        <RouterLink
                            v-if="quickJobsOnly(rung.model) && rung.installed?.status.state === `active`"
                            to="/sandbox/agent#models"
                            :class="ui.textButton({ size: `xs` })"
                        >
                            {{ t(`connect.localModelLane.useForQuickJobs`) }}<Icon name="arrow-right" class="text-2xs" />
                        </RouterLink>

                        <!-- The prefetch is why a rung can be instant; said as a fact, with its own stop, never as a silent
                             transfer. Gone once the rung is taken: the entry's own status reports the same bytes from then on. -->
                        <p
                            v-if="!rung.installed && fit.prefetch.state === `downloading` && fit.prefetch.model === rung.model"
                            class="flex items-center gap-1.5 text-2xs text-subtle"
                        >
                            <Icon name="spinner" spin />
                            <span class="min-w-0">{{
                                fit.prefetch.totalBytes > 0
                                    ? t(`connect.localModelLane.gettingReady`, {
                                          received: gb(fit.prefetch.receivedBytes),
                                          total: gb(fit.prefetch.totalBytes),
                                      })
                                    : t(`connect.localModelLane.gettingReadyPlain`)
                            }}</span>
                            <!-- Leaves the part file: stopping is declining to wait, not throwing away what has arrived. -->
                            <button type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` }, `shrink-0`)" @click="emit(`stopPrefetch`)">
                                {{ t(`connect.localModelLane.stop`) }}
                            </button>
                        </p>
                    </div>
                </template>
            </Row>

            <!-- The add's last log line, or why it failed: only while there is one, never an empty row. -->
            <RowNote v-if="note || failure" variant="block">
                <p v-if="note" class="text-2xs text-subtle">{{ note }}</p>
                <p v-if="failure" class="text-2xs text-danger">{{ failure }}</p>
            </RowNote>
        </div>
    </div>
</template>
