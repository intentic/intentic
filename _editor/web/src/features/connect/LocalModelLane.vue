<script setup lang="ts">
import { CAPABILITY_CATALOG, localModelGb } from "@intentic/capability-catalog";
import { type LocalModelFitResponse, LOCAL_MODEL_WINDOW_DEFAULT } from "@intentic/sandbox-contract";
import { Button, Icon, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { useCapabilities } from "../capabilities/connect/useCapabilities";
import { suggestName } from "../capabilities/model/cards";
import { useT } from "@intentic/ui/i18n";

// The machine the reader already owns, offered as a peer of the two account lanes. Two rungs and no arithmetic: one
// that is ready in a minute and says plainly what it is good for, one that is the most this box can hold. Everything
// quoted here is measured in the sandbox (memory, GPU, weights on disk) rather than assumed from a table.

const t = useT();

const { fit } = defineProps<{ fit: LocalModelFitResponse | undefined }>();
const emit = defineEmits<{ added: [provider: string]; stopPrefetch: [] }>();

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

const addModel = async (model: string, context: string): Promise<void> => {
    if (busy.value !== undefined) {
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
        emit(`added`, `endpoint/${id}`);
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

            <template v-else>
                <!-- Ready in a minute, and honest about what that buys: this rung cannot drive a full agent turn. -->
                <div v-if="fit.instant && !bestIsInstant" class="flex flex-col gap-2 rounded-xl border border-line bg-card p-3">
                    <div class="flex flex-wrap items-center gap-2">
                        <Icon name="bolt" class="shrink-0 text-warning" />
                        <span class="text-sm font-medium text-content">{{ optionOf(fit.instant.model)?.label }}</span>
                        <span class="rounded bg-content/5 px-1.5 py-0.5 text-[0.6rem] font-medium text-subtle">{{
                            t(`connect.localModelLane.quickJobsOnly`)
                        }}</span>
                        <Button
                            class="ml-auto"
                            size="small"
                            :label="t(`connect.localModelLane.startNow`)"
                            :loading="busy === fit.instant.model"
                            :disabled="busy !== undefined"
                            @click="addModel(fit.instant.model, fit.instant.context)"
                        />
                    </div>
                    <p class="text-2xs text-muted">
                        {{ t(`connect.localModelLane.instantPitch`) }} {{ priceOf(fit.instant.model, fit.instant.context) }}
                    </p>
                    <!-- The prefetch is why this is instant; said as a fact, with its own stop, never as a silent transfer. -->
                    <p v-if="fit.prefetch.state === `downloading`" class="flex items-center gap-1.5 text-2xs text-subtle">
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

                <!-- What this machine is actually for: the heaviest weights it holds, at a window a full turn fits in. -->
                <div v-if="fit.best" class="flex flex-col gap-2 rounded-xl border border-line bg-card p-3">
                    <div class="flex flex-wrap items-center gap-2">
                        <Icon name="cpu" class="shrink-0 text-link" />
                        <span class="text-sm font-medium text-content">{{ optionOf(fit.best.model)?.label }}</span>
                        <span class="rounded bg-primary-500/15 px-1.5 py-0.5 text-[0.6rem] font-medium text-primary-500">{{
                            t(`connect.localModelLane.bestHere`)
                        }}</span>
                        <Button
                            class="ml-auto"
                            size="small"
                            :label="t(`connect.localModelLane.runIt`)"
                            :loading="busy === fit.best.model"
                            :disabled="busy !== undefined"
                            @click="addModel(fit.best.model, fit.best.context)"
                        />
                    </div>
                    <p class="text-2xs text-muted">
                        {{ t(`connect.localModelLane.bestPitch`, { window: Number(fit.best.context) / 1024 }) }}
                        {{ priceOf(fit.best.model, fit.best.context) }}
                    </p>
                    <!-- A window under the contract's default cannot hold one agent turn, and the offer has to say so. -->
                    <p v-if="Number(fit.best.context) < Number(LOCAL_MODEL_WINDOW_DEFAULT)" class="text-2xs text-warning">
                        {{ t(`connect.localModelLane.windowUnderFloor`) }}
                    </p>
                </div>
            </template>

            <p v-if="note" class="text-2xs text-subtle">{{ note }}</p>
            <p v-if="failure" class="text-2xs text-danger">{{ failure }}</p>

            <!-- Everything this lane decides for the reader is changeable on the card it just wrote. -->
            <RouterLink to="/capabilities/localmodel" :class="ui.linkButton(`text-2xs`)">
                {{ t(`connect.localModelLane.moreModels`) }}<Icon name="arrow-right" class="text-2xs" />
            </RouterLink>
        </template>
    </div>
</template>
