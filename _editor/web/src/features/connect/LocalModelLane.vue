<script setup lang="ts">
import type { CapabilitySummary } from "@intentic/api-contract";
import { CAPABILITY_CATALOG, localModelGb } from "@intentic/capability-catalog";
import { type LocalModelFitResponse, LOCAL_MODEL_WINDOW_DEFAULT } from "@intentic/sandbox-contract";
import { Button, Icon, type IconName, ui } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { useCapabilities } from "../capabilities/connect/useCapabilities";
import { suggestName } from "../capabilities/model/tiles";
import { useT } from "@intentic/ui/i18n";

// The machine the reader already owns, offered as a peer of the two account lanes. Two rungs and no arithmetic: one
// that is ready in a minute and says plainly what it is good for, one that is the most this box can hold. Everything
// quoted here is measured in the sandbox (memory, GPU, weights on disk) rather than assumed from a table.
//
// A rung that has been taken reports instead of offering: the add writes a manifest entry in seconds and the server
// then loads for minutes, so the press that looks finished is the start of the wait, not the end of it.

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

// What each offer costs in one sentence: the download only where there is one, then the memory it will hold.
const priceOf = (model: string, context: string): string => {
    const option = optionOf(model);
    if (option === undefined) {
        return ``;
    }
    const window = option.windows.find((entry) => entry.tokens === Number(context));
    const total = window === undefined ? undefined : gb(window.totalBytes);
    return option.held
        ? t(`connect.localModelLane.alreadyDownloadedNeeds`, { total })
        : t(`connect.localModelLane.downloadNeeds`, { download: gb(option.weightsBytes), total });
};

// The model this lane just started, watched until the daemon says it serves. Held here rather than announced on the
// add's return because the add returns while llama-server is still loading its weights, and a chat opened then fails.
const starting = ref<string | undefined>(undefined);
watch(
    () => (starting.value === undefined ? undefined : installedFor(starting.value)),
    (entry) => {
        if (entry === undefined || entry.status.state === `pending`) {
            return;
        }
        starting.value = undefined;
        // The apply's last log line was about the wait; the rung's own status has taken that over by now.
        note.value = undefined;
        if (entry.status.state === `active`) {
            emit(`ready`, `endpoint/${entry.id}`);
        }
    },
);

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

// The GPU is the one fact this lane cannot measure before it is granted: `absent` means nobody asked, which is a switch
// worth offering on the card, and `unsupported` means the host's Docker answered and has no nvidia runtime.
const gpuLine = computed(() => {
    if (fit === undefined) {
        return undefined;
    }
    if (fit.gpu === `granted`) {
        return t(`connect.localModelLane.gpuGranted`, { vram: gb(fit.gpuMemoryBytes) });
    }
    return fit.gpu === `unsupported` ? t(`connect.localModelLane.gpuUnsupported`) : t(`connect.localModelLane.gpuOffered`);
});

const memoryLine = computed(() =>
    fit === undefined
        ? undefined
        : fit.memoryCapped
          ? t(`connect.localModelLane.memoryCapped`, { memory: gb(fit.memoryBytes) })
          : t(`connect.localModelLane.memoryMachine`, { memory: gb(fit.memoryBytes) }),
);

const nothingFits = computed(() => fit !== undefined && fit.instant === undefined && fit.best === undefined);
// Two offers that name the same model collapse into one: a small machine would otherwise be handed the same row twice.
const bestIsInstant = computed(() => fit?.best !== undefined && fit.best.model === fit.instant?.model);

// The rungs in reading order, each carrying whatever entry already holds its weights so the row below decides between
// an offer and a report once, not twice.
const rungs = computed(() => {
    const offers: { key: string; model: string; context: string; icon: IconName; iconClass: string; badge: string; badgeClass: string; action: string; pitch: string; warn: string | undefined }[] = [];
    if (fit?.instant !== undefined && !bestIsInstant.value) {
        offers.push({
            key: `instant`,
            model: fit.instant.model,
            context: fit.instant.context,
            icon: `bolt`,
            iconClass: `text-warning`,
            badge: t(`connect.localModelLane.quickJobsOnly`),
            badgeClass: `bg-content/5 text-subtle`,
            action: t(`connect.localModelLane.startNow`),
            pitch: t(`connect.localModelLane.instantPitch`),
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
            badgeClass: `bg-primary-500/15 text-primary-500`,
            action: t(`connect.localModelLane.runIt`),
            pitch: t(`connect.localModelLane.bestPitch`, { window: Number(fit.best.context) / 1024 }),
            // A window under the contract's default cannot hold one agent turn, and the offer has to say so.
            warn: Number(fit.best.context) < Number(LOCAL_MODEL_WINDOW_DEFAULT) ? t(`connect.localModelLane.windowUnderFloor`) : undefined,
        });
    }
    return offers.map((offer) => ({ ...offer, installed: installedFor(offer.model) }));
});

// `inactive` cannot reach this lane (nothing here switches a model off), so it reads with the spinner rather than
// inventing a fourth glyph for a state the daemon does not give a local model.
const STATE_ICON: Record<string, IconName> = { active: `check`, error: `exclamation-triangle` };
const stateIcon = (state: string): IconName => STATE_ICON[state] ?? `spinner`;
const STATE_TONE: Record<string, string> = { active: `text-success`, error: `text-danger` };
const stateTone = (state: string): string => STATE_TONE[state] ?? `text-subtle`;
</script>

<template>
    <div class="flex flex-col gap-3">
        <!-- Nothing is offered before the machine has answered; a skeleton beats a number we would have to take back. -->
        <p v-if="fit === undefined" class="flex items-center gap-1.5 text-xs text-subtle">
            <Icon name="spinner" spin />{{ t(`connect.localModelLane.measuring`) }}
        </p>

        <template v-else>
            <p class="text-xs text-muted">
                {{ memoryLine }} <span class="text-subtle">{{ gpuLine }}</span>
            </p>

            <!-- llama-server is baked into the standard image, so this is the dev-run and core-image case, not the usual one. -->
            <p v-if="!fit.serverReady" :class="ui.emptyState(`text-left`)">{{ t(`connect.localModelLane.needsRebuild`) }}</p>

            <p v-else-if="nothingFits" :class="ui.emptyState(`text-left`)">
                {{ t(`connect.localModelLane.nothingFits`, { memory: gb(fit.memoryBytes) }) }}
            </p>

            <div v-for="rung in rungs" v-else :key="rung.key" class="flex flex-col gap-2 rounded-xl border border-line bg-card p-3">
                <div class="flex flex-wrap items-center gap-2">
                    <Icon :name="rung.icon" class="shrink-0" :class="rung.iconClass" />
                    <span class="text-sm font-medium text-content">{{ optionOf(rung.model)?.label }}</span>
                    <span class="rounded px-1.5 py-0.5 text-[0.6rem] font-medium" :class="rung.badgeClass">{{ rung.badge }}</span>

                    <!-- Taken: the daemon's own words for where it has got to, in place of a button whose second press
                         would write a second entry and leave this one without the machine's single server slot. -->
                    <span v-if="rung.installed" class="ml-auto flex min-w-0 items-center gap-1.5 text-2xs" :class="stateTone(rung.installed.status.state)">
                        <Icon :name="stateIcon(rung.installed.status.state)" :spin="stateIcon(rung.installed.status.state) === `spinner`" class="shrink-0" />
                        <span class="truncate">{{
                            rung.installed.status.state === `active`
                                ? t(`connect.localModelLane.ready`)
                                : (rung.installed.status.detail ?? t(`connect.localModelLane.starting`))
                        }}</span>
                    </span>
                    <Button
                        v-else
                        class="ml-auto"
                        size="small"
                        :label="rung.action"
                        :loading="busy === rung.model"
                        :disabled="busy !== undefined"
                        @click="addModel(rung.model, rung.context)"
                    />
                </div>
                <p class="text-2xs text-muted">{{ rung.pitch }} {{ priceOf(rung.model, rung.context) }}</p>
                <p v-if="rung.warn" class="text-2xs text-warning">{{ rung.warn }}</p>

                <!-- The prefetch is why a rung can be instant; said as a fact, with its own stop, never as a silent
                     transfer. Gone once the rung is taken: the entry's own status reports the same bytes from then on. -->
                <p
                    v-if="!rung.installed && fit.prefetch.state === `downloading` && fit.prefetch.model === rung.model"
                    class="flex items-center gap-1.5 text-2xs text-subtle"
                >
                    <Icon name="spinner" spin />
                    <span class="min-w-0 flex-1">{{
                        fit.prefetch.totalBytes > 0
                            ? t(`connect.localModelLane.gettingReady`, {
                                  received: gb(fit.prefetch.receivedBytes),
                                  total: gb(fit.prefetch.totalBytes),
                              })
                            : t(`connect.localModelLane.gettingReadyPlain`)
                    }}</span>
                    <!-- Leaves the part file: stopping is declining to wait, not throwing away what has arrived. -->
                    <button type="button" :class="ui.textAction(`shrink-0 text-2xs`)" @click="emit(`stopPrefetch`)">
                        {{ t(`connect.localModelLane.stop`) }}
                    </button>
                </p>
            </div>

            <p v-if="note" class="text-2xs text-subtle">{{ note }}</p>
            <p v-if="failure" class="text-2xs text-danger">{{ failure }}</p>

            <!-- Everything this lane decides for the reader is changeable on the card it just wrote. -->
            <RouterLink to="/capabilities/localmodel" :class="ui.linkButton(`text-2xs`)">
                {{ t(`connect.localModelLane.moreModels`) }}<Icon name="arrow-right" class="text-2xs" />
            </RouterLink>
        </template>
    </div>
</template>
