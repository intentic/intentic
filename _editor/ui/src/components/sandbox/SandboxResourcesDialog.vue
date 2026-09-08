<!--
    Confirmation dialog for one sandbox's memory, CPU, privileged and GPU share; shared by the web and desktop apps. Props are read-only facts —
    sandboxResources.js owns validation and locks. Apply emits only the fields changed from the opened share.
-->
<script setup lang="ts">
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, useId, watch } from "vue";
import Button from "../primitives/Button.vue";
import Icon from "../primitives/Icon.vue";
import type { DeviceSandboxResources } from "./deviceDetail.js";
import Modal from "../overlays/Modal.vue";
import Row from "../rows/Row.vue";
import {
    askFrom,
    capFromField,
    cpuBounds,
    type EngineFacts,
    formFrom,
    formProblems,
    gpuDropped,
    locksOf,
    memoryBounds,
    type ResourcesAsk,
    type ResourcesForm,
} from "./sandboxResources.js";
import { ui } from "../../lib/ui.js";

const {
    open,
    name,
    current,
    engine,
    selfWarning = false,
} = defineProps<{
    open: boolean;
    /** What to call the sandbox in the header: the row's own title. */
    name: string;
    /**
     * The container's share as it runs now, read off docker by whoever lists the machine. Undefined only while closed.
     */
    current?: DeviceSandboxResources | undefined;
    /** The Docker engine's size, the rails the two caps run between. Absent when the machine could not say. */
    engine?: EngineFacts | undefined;
    /** Whether this is the sandbox serving the page, which the restart will take down. */
    selfWarning?: boolean;
}>();

const emit = defineEmits<{ cancel: []; apply: [ask: ResourcesAsk] }>();

// The form starts from the container every time it opens, not from where the last visit left it, so a
// share changed by an Apply in between is what the next open shows.
const EMPTY: ResourcesForm = { memoryGib: null, cpus: null, privileged: false, gpu: false };
const initial = ref<ResourcesForm>(EMPTY);
const form = ref<ResourcesForm>(EMPTY);
watch(
    () => [open, current] as const,
    ([showing, share]) => {
        if (showing && share !== undefined) {
            initial.value = formFrom(share);
            form.value = { ...initial.value };
        }
    },
    { immediate: true },
);

const locks = computed(() => (current === undefined ? {} : locksOf(current)));
const dropped = computed(() => current !== undefined && gpuDropped(current));
const memory = computed(() => memoryBounds(engine));
const cpus = computed(() => cpuBounds(engine));
const problems = computed(() => formProblems(form.value, engine));
const ask = computed(() => askFrom(initial.value, form.value));
const ready = computed(() => ask.value !== undefined && problems.value.memory === undefined && problems.value.cpus === undefined);

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
const memoryPlaceholder = computed(() => (memory.value.max === undefined ? `default` : `default: ${memory.value.max}`));
const cpuPlaceholder = computed(() => (cpus.value.max === undefined ? `all` : `all ${cpus.value.max}`));

const uid = useId();
</script>

<template>
    <Modal :open="open" size="md" :header="`Resources for ${name}`" @update:open="emit(`cancel`)">
        <div v-if="current !== undefined" class="flex flex-col gap-4">
            <!--
                The four rows share one bordered box (the shape <ExportBundleDialog> settled on) rather than <Row>'s
                own padding, since a modal's body padding isn't a number this file may assume.
            -->
            <div class="flex flex-col overflow-hidden rounded-lg border border-line divide-y divide-line-subtle">
                <!-- Memory is whole GiB; empty means the default, said by the placeholder rather than a second control. -->
                <Row flush density="compact" icon="server" title="Memory" class="px-3.5 py-3" :tone="problems.memory === undefined ? `default` : `warning`">
                    <template #description>
                        Whole GiB, {{ memory.min }}<template v-if="memory.max !== undefined"> to {{ memory.max }}</template> on this computer. Empty is the
                        default: everything it has beyond what it keeps for itself.
                    </template>
                    <template #control>
                        <!--
                            The unit sits in a fixed, right-aligned span rather than loose text, so the two cap fields'
                            numbers line up.
                        -->
                        <label class="flex items-center gap-2 text-xs text-muted">
                            <input
                                :id="`${uid}-memory`"
                                type="number"
                                :min="memory.min"
                                :max="memory.max"
                                step="1"
                                :value="form.memoryGib ?? ``"
                                :placeholder="memoryPlaceholder"
                                aria-label="Memory cap in GiB"
                                :class="ui.inputSm(`w-28 text-right`)"
                                @input="setCap(`memoryGib`, $event)"
                            />
                            <span class="w-10 text-right">GiB</span>
                        </label>
                    </template>
                    <template v-if="problems.memory !== undefined" #below>
                        <p class="text-2xs text-warning">{{ problems.memory }}</p>
                    </template>
                </Row>

                <!-- CPUs default to no ceiling at all (every core), the opposite kind of default from memory's. -->
                <Row flush density="compact" icon="cpu" title="CPUs" class="px-3.5 py-3" :tone="problems.cpus === undefined ? `default` : `warning`">
                    <template #description>
                        Whole CPUs, {{ cpus.min }}<template v-if="cpus.max !== undefined"> to {{ cpus.max }}</template> on this computer. Empty is no limit:
                        every core it has.
                    </template>
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
                                aria-label="CPU cap in cores"
                                :class="ui.inputSm(`w-28 text-right`)"
                                @input="setCap(`cpus`, $event)"
                            />
                            <span class="w-10 text-right">cores</span>
                        </label>
                    </template>
                    <template v-if="problems.cpus !== undefined" #below>
                        <p class="text-2xs text-warning">{{ problems.cpus }}</p>
                    </template>
                </Row>

                <!--
                    Locked, with the reason, when the approved environment demands it: a reshape can add to what it
                    asks
                    but never withdraw it.
                -->
                <Row flush density="compact" icon="shield" title="Privileged" class="px-3.5 py-3" :tone="form.privileged ? `warning` : `default`">
                    <template #description>
                        Full access to this computer's devices and kernel, the way a nested Docker engine needs. Only for a tool that cannot run
                        without it.
                    </template>
                    <template #control>
                        <ToggleSwitch
                            :model-value="form.privileged"
                            :disabled="locks.privileged !== undefined"
                            aria-label="Run privileged"
                            @update:model-value="(value: boolean) => (form = { ...form, privileged: value })"
                        />
                    </template>
                    <template v-if="locks.privileged !== undefined" #below>
                        <p class="text-2xs text-muted">{{ locks.privileged }}</p>
                    </template>
                </Row>

                <!--
                    The one switch whose ask and answer can disagree: a host without the NVIDIA runtime drops the flag
                    and
                    the sandbox starts without it.
                -->
                <Row flush density="compact" icon="bolt" title="GPU" class="px-3.5 py-3">
                    <template #description>Pass this computer's NVIDIA GPUs into the sandbox: the driver rides in with them.</template>
                    <template #control>
                        <ToggleSwitch
                            :model-value="form.gpu"
                            :disabled="locks.gpu !== undefined"
                            aria-label="Pass the GPU through"
                            @update:model-value="(value: boolean) => (form = { ...form, gpu: value })"
                        />
                    </template>
                    <template v-if="locks.gpu !== undefined || dropped" #below>
                        <p v-if="locks.gpu !== undefined" class="text-2xs text-muted">{{ locks.gpu }}</p>
                        <p v-if="dropped" class="text-2xs text-warning">
                            Asked for, but this computer has no NVIDIA container runtime, so the sandbox runs without it.
                        </p>
                    </template>
                </Row>
            </div>

            <!--
                What applying costs, beside the button that commits it; every sentence keeps the sandbox, not the
                computer, as its subject.
            -->
            <p class="text-xs text-muted">
                Applying restarts the sandbox onto the same image, about a minute, and interrupts whoever is working in it. Its files (in /work) are
                kept, and the new share survives every later update, rollback and rebuild.
            </p>
            <p v-if="selfWarning" class="text-xs text-warning">This is the sandbox you are using right now: this page will lose it until it is back.</p>
        </div>

        <template #footer>
            <Button label="Cancel" severity="secondary" :text="true" @click="emit(`cancel`)" />
            <!--
                Disabled rather than refused: nothing changed, or a cap outside the rails, leaves nothing for the
                machine to accept. Not danger-red: it keeps the sandbox's files.
            -->
            <Button label="Apply" :disabled="!ready" @click="ask !== undefined && emit(`apply`, ask)">
                <template #icon><Icon name="bolt" /></template>
            </Button>
        </template>
    </Modal>
</template>
