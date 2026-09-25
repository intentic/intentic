<!-- Confirmation dialog for one sandbox's memory, CPU, privileged and GPU share; shared by the web and desktop apps.
     It holds a WHOLE shape and emits one: Apply restarts the sandbox onto it now; Save (where the caller can carry it)
     has ic keep it for the sandbox's next restart through ic. -->
<script setup lang="ts">
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, useId, watch } from "vue";
import Button from "../primitives/Button.vue";
import { useT } from "../../i18n/index.js";
import Icon from "../primitives/Icon.vue";
import type { DeviceSandboxResources } from "./deviceDetail.js";
import Modal from "../overlays/Modal.vue";
import Row from "../rows/Row.vue";
import {
    capFromField,
    cpuBounds,
    defaultMemoryGib,
    type EngineFacts,
    engineMemoryGib,
    formProblems,
    gpuDropped,
    locksOf,
    MEMORY_BOUNDS,
    type ResourcesForm,
    runningShape,
    sameShape,
    shapeSummary,
} from "./sandboxResources.js";
import { ui } from "../../lib/ui.js";

const t = useT();

const {
    open,
    name,
    current,
    engine,
    selfWarning = false,
    suggestMemoryGib,
    canSave = false,
} = defineProps<{
    open: boolean;
    /** What to call the sandbox in the header: the row's own title. */
    name: string;
    /**
     * The container's share as it runs now, read off docker by whoever lists the machine. Undefined only while closed.
     */
    current?: DeviceSandboxResources | undefined;
    /** The Docker engine's size: the CPU rail, the memory default, and all a sandbox can use. Absent when the machine could not say. */
    engine?: EngineFacts | undefined;
    /** Whether this is the sandbox serving the page, which the restart will take down. */
    selfWarning?: boolean;
    /**
     * A memory cap to open with already typed in, for a caller that opened this form BECAUSE of the cap (the
     * out-of-memory notice). Only the field moves: `running` stays the shape the container runs with, so Apply sends the
     * difference and the reader sees what they are about to change from.
     */
    suggestMemoryGib?: number | undefined;
    /**
     * Whether the caller can have ic save a shape for the sandbox's next restart (a machine agent with `set-shape`,
     * the desktop app), which adds the Save button. Off for a caller whose door has no such thing.
     */
    canSave?: boolean;
}>();

// Both carry the whole shape the form holds. `save` carries undefined to forget what is saved, which is what saving
// the shape that already runs means.
const emit = defineEmits<{ cancel: []; apply: [shape: ResourcesForm]; save: [shape: ResourcesForm | undefined] }>();

// The form starts from the container every time it opens, not from where the last visit left it, so a
// shape changed by an Apply in between is what the next open shows. `running` is what RUNS; the fields open on
// the shape saved for the next restart when there is one, so that is what the reader sees and edits.
const EMPTY: ResourcesForm = { memoryGib: null, cpus: null, privileged: false, gpu: false };
const running = ref<ResourcesForm>(EMPTY);
const form = ref<ResourcesForm>(EMPTY);
watch(
    () => [open, current, suggestMemoryGib] as const,
    ([showing, share, suggested]) => {
        if (showing && share !== undefined) {
            running.value = runningShape(share);
            form.value = { ...(share.desired ?? running.value), ...(suggested === undefined ? {} : { memoryGib: suggested }) };
        }
    },
    { immediate: true },
);

const locks = computed(() => (current === undefined ? {} : locksOf(current)));
const dropped = computed(() => current !== undefined && gpuDropped(current));
const memoryDefault = computed(() => defaultMemoryGib(engine));
const engineGib = computed(() => engineMemoryGib(engine));
const cpus = computed(() => cpuBounds(engine));
const problems = computed(() => formProblems(form.value, engine));
const desired = computed(() => current?.desired);
const desiredSummary = computed(() => (desired.value === undefined ? undefined : shapeSummary(desired.value)));
const valid = computed(() => problems.value.memory === undefined && problems.value.cpus === undefined);
// Apply is worth pressing when the form differs from what runs, or when a saved shape is waiting to be applied.
const applyReady = computed(() => valid.value && (!sameShape(form.value, running.value) || desired.value !== undefined));
// Save is worth pressing when it would change what is saved: a new shape, or forgetting the one there is.
const saveShape = computed(() => (sameShape(form.value, running.value) ? undefined : form.value));
const saveReady = computed(() => valid.value && !sameShape(form.value, desired.value ?? running.value));

// A cap field's text, read back on every keystroke: the problem and the Apply button both follow the
// typing. Not-a-number mid-edit leaves the form as it was, rather than flipping the cap to the default.
const setCap = (field: `memoryGib` | `cpus`, event: Event): void => {
    const value = capFromField((event.target as HTMLInputElement).value);
    if (value !== undefined) {
        form.value = { ...form.value, [field]: value };
    }
};

// What an empty field means, said in the field: a measured engine can name the default; an unmeasured one names the
// rule.
const memoryPlaceholder = computed(() =>
    memoryDefault.value === undefined
        ? t(`ui.sandboxResourcesDialog.default`)
        : t(`ui.sandboxResourcesDialog.defaultIs`, { value: memoryDefault.value }),
);
const cpuPlaceholder = computed(() =>
    cpus.value.max === undefined ? t(`ui.sandboxResourcesDialog.all`) : t(`ui.sandboxResourcesDialog.allMax`, { max: cpus.value.max }),
);

// The floor always, and the engine's size where measured, since a cap past it is no cap.
const memoryDescription = computed(() =>
    engineGib.value === undefined
        ? t(`ui.sandboxResourcesDialog.memoryWhole`, { min: MEMORY_BOUNDS.min })
        : t(`ui.sandboxResourcesDialog.memoryWholeOf`, { min: MEMORY_BOUNDS.min, engine: engineGib.value }),
);

// The CPU bounds as one phrase inside the sentence that reports them, rather than three fragments the markup joins: an
// unmeasured engine has no ceiling to name, and a translator needs the whole sentence to move its words around.
const bounds = (measured: { min: number; max?: number }): string =>
    measured.max === undefined ? String(measured.min) : t(`ui.sandboxResourcesDialog.range`, { min: measured.min, max: measured.max });

const uid = useId();
</script>

<template>
    <Modal :open="open" size="md" :header="t(`ui.sandboxResourcesDialog.resources`, { name })" @update:open="emit(`cancel`)">
        <div v-if="current !== undefined" class="flex flex-col gap-4">
            <!-- The four rows share one bordered box (the shape <ExportBundleDialog> settled on) rather than <Row>'s own padding. -->
            <div class="flex flex-col overflow-hidden rounded-lg border border-line divide-y divide-line-subtle">
                <!-- Memory is whole GiB; empty means the default, said by the placeholder rather than a second control. -->
                <Row
                    flush
                    density="compact"
                    icon="server"
                    :title="t(`ui.sandboxResourcesDialog.memory`)"
                    class="px-3.5 py-3"
                    :tone="problems.memory === undefined ? `default` : `warning`"
                >
                    <template #description>{{ memoryDescription }}</template>
                    <template #control>
                        <!-- The unit sits in a fixed, right-aligned span rather than loose text, so the two cap fields' numbers line up. -->
                        <label class="flex items-center gap-2 text-xs text-muted">
                            <input
                                :id="`${uid}-memory`"
                                type="number"
                                :min="MEMORY_BOUNDS.min"
                                step="1"
                                :value="form.memoryGib ?? ``"
                                :placeholder="memoryPlaceholder"
                                :aria-label="t(`ui.sandboxResourcesDialog.memoryCapInGib`)"
                                :class="ui.inputSm(`w-28 text-right`)"
                                @input="setCap(`memoryGib`, $event)"
                            />
                            <span class="w-10 text-right">{{ t(`ui.sandboxResourcesDialog.gib`) }}</span>
                        </label>
                    </template>
                    <template v-if="problems.memory !== undefined" #below>
                        <p class="text-2xs text-warning">{{ problems.memory }}</p>
                    </template>
                </Row>

                <!-- CPUs default to no ceiling at all (every core), the opposite kind of default from memory's. -->
                <Row
                    flush
                    density="compact"
                    icon="cpu"
                    :title="t(`ui.sandboxResourcesDialog.cpus`)"
                    class="px-3.5 py-3"
                    :tone="problems.cpus === undefined ? `default` : `warning`"
                >
                    <template #description>{{ t(`ui.sandboxResourcesDialog.cpusWhole`, { bounds: bounds(cpus) }) }}</template>
                    <template #control>
                        <label class="flex items-center gap-2 text-xs text-muted">
                            <input
                                :id="`${uid}-cpus`"
                                type="number"
                                :min="cpus.min"
                                :max="cpus.max"
                                step="1"
                                :value="form.cpus ?? ``"
                                :placeholder="cpuPlaceholder"
                                :aria-label="t(`ui.sandboxResourcesDialog.cpuCapInCores`)"
                                :class="ui.inputSm(`w-28 text-right`)"
                                @input="setCap(`cpus`, $event)"
                            />
                            <span class="w-10 text-right">{{ t(`ui.sandboxResourcesDialog.cores`) }}</span>
                        </label>
                    </template>
                    <template v-if="problems.cpus !== undefined" #below>
                        <p class="text-2xs text-warning">{{ problems.cpus }}</p>
                    </template>
                </Row>

                <!-- Locked, with the reason, when the approved environment demands it: a reshape can add to what it asks but never withdraw it. -->
                <Row
                    flush
                    density="compact"
                    icon="shield"
                    :title="t(`ui.sandboxResourcesDialog.privileged`)"
                    class="px-3.5 py-3"
                    :tone="form.privileged ? `warning` : `default`"
                >
                    <template #description>
                        {{ t(`ui.sandboxResourcesDialog.fullAccessToComputers`) }}
                    </template>
                    <template #control>
                        <ToggleSwitch
                            :model-value="form.privileged || locks.privileged !== undefined"
                            :disabled="locks.privileged !== undefined"
                            :aria-label="t(`ui.sandboxResourcesDialog.runPrivileged`)"
                            @update:model-value="(value: boolean) => (form = { ...form, privileged: value })"
                        />
                    </template>
                    <template v-if="locks.privileged !== undefined" #below>
                        <p class="text-2xs text-muted">{{ locks.privileged }}</p>
                    </template>
                </Row>

                <!-- The one switch whose ask and answer can disagree: a host without the NVIDIA runtime drops the flag and the sandbox starts without it. -->
                <Row flush density="compact" icon="bolt" :title="t(`ui.sandboxResourcesDialog.gpu`)" class="px-3.5 py-3">
                    <template #description>{{ t(`ui.sandboxResourcesDialog.passComputersNvidiaGpus`) }}</template>
                    <template #control>
                        <ToggleSwitch
                            :model-value="form.gpu || locks.gpu !== undefined"
                            :disabled="locks.gpu !== undefined"
                            :aria-label="t(`ui.sandboxResourcesDialog.passGpuThrough`)"
                            @update:model-value="(value: boolean) => (form = { ...form, gpu: value })"
                        />
                    </template>
                    <template v-if="locks.gpu !== undefined || dropped" #below>
                        <p v-if="locks.gpu !== undefined" class="text-2xs text-muted">{{ locks.gpu }}</p>
                        <p v-if="dropped" class="text-2xs text-warning">
                            {{ t(`ui.sandboxResourcesDialog.askedComputerNoNvidia`) }}
                        </p>
                    </template>
                </Row>
            </div>

            <!-- A shape already saved and not yet in force: named, so the fields showing it are not mistaken for what runs. -->
            <p v-if="desiredSummary !== undefined" class="text-xs text-info">
                {{ t(`ui.sandboxResourcesDialog.savedForNextRestart`, { share: desiredSummary }) }}
            </p>

            <!-- What applying costs, beside the button that commits it; every sentence keeps the sandbox, not the computer, as its subject. -->
            <p class="text-xs text-muted">
                {{ t(`ui.sandboxResourcesDialog.applyingRestartsSandboxOnto`) }}
            </p>
            <p v-if="canSave" class="text-xs text-muted">
                {{ t(`ui.sandboxResourcesDialog.savingKeepsItRunning`) }}
            </p>
            <p v-if="selfWarning" class="text-xs text-warning">
                {{ t(`ui.sandboxResourcesDialog.sandboxUsingRightNow`) }}
            </p>
        </div>

        <template #footer>
            <Button :label="t(`ui.action.cancel`)" severity="secondary" :text="true" @click="emit(`cancel`)" />
            <!-- Disabled rather than refused: nothing changed, or a cap outside the rails, leaves nothing for the machine to accept. -->
            <Button
                v-if="canSave"
                :label="t(`ui.sandboxResourcesDialog.saveForNextRestart`)"
                severity="secondary"
                :disabled="!saveReady"
                @click="emit(`save`, saveShape)"
            />
            <Button :label="canSave ? t(`ui.sandboxResourcesDialog.applyNow`) : t(`ui.action.apply`)" :disabled="!applyReady" @click="emit(`apply`, form)">
                <template #icon><Icon name="bolt" /></template>
            </Button>
        </template>
    </Modal>
</template>
