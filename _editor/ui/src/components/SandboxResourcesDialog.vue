<!-- ONE SANDBOX'S SHARE OF ITS MACHINE, AS A FORM: the memory and CPU caps docker holds it to, whether it runs
     privileged, whether the host's GPU rides along. Behind the row's Resources… verb in both apps, and drawn once
     for the reason <SandboxVerbs> is: the web tab and the desktop manager change the same containers on the same
     machine, and a knob that exists in one and not the other, or with different rails, is the drift the shared
     kit exists to end.

     THE FORM IS THE CONFIRMATION. Applying is a recreate onto the same image, about a minute of the sandbox
     being down, so the cost is stated beside the button that commits it rather than asked again in a second
     dialog after this one (sandboxVerbs.ts says why the verb itself has no prompt). The caller says whether
     this is the sandbox serving the page (`selfWarning`), the one thing about the row this component cannot know.

     STRUCTURAL PROPS, and the caller's job is only to hand them over: the container's current share as the
     machine read it off docker, the engine's size for the rails, and a name for the header. Every judgement
     about them (where the form starts, which switch is locked and why, what the machine will accept, what has
     changed) is sandboxResources.ts, so it is pinned in a test rather than read out of this template.

     WHAT LEAVES IS A DIFF. `apply` carries only what changed against the share the dialog opened on, in the
     sandbox contract's own ask shape, so a person who opened this to raise memory does not also re-state the
     CPU cap, and the machine's refusal of a reshape with nothing in it is unreachable from here (Apply is
     disabled on it). The dialog closes on Apply and the ROW narrates the restart, as it does for every other
     verb: a modal holding a spinner over the page for a minute would hide the very stream it is about. -->
<script setup lang="ts">
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, useId, watch } from "vue";
import Button from "./Button.vue";
import Icon from "./Icon.vue";
import type { DeviceSandboxResources } from "./deviceDetail.js";
import Modal from "./Modal.vue";
import Row from "./Row.vue";
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
import { ui } from "../lib/ui.js";

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
    /** The container's share as it runs now, read off docker by whoever lists the machine. Undefined only while closed. */
    current?: DeviceSandboxResources | undefined;
    /** The Docker engine's size, the rails the two caps run between. Absent when the machine could not say. */
    engine?: EngineFacts | undefined;
    /** Whether this is the sandbox serving the page, which the restart will take down. */
    selfWarning?: boolean;
}>();

const emit = defineEmits<{ cancel: []; apply: [ask: ResourcesAsk] }>();

/* THE FORM STARTS FROM THE CONTAINER EVERY TIME IT OPENS, not from where the last visit left it: a dialog
 * dismissed mid-thought has to come back describing the sandbox as it runs, and a share changed by an Apply in
 * between must be what the next open shows. Watched on `open` and on `current` together, because the caller
 * may hand over the share a tick after raising the dialog. */
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

/* A cap field's text, read back on every keystroke rather than on blur: the problem under the field and the
 * Apply button both follow the typing, so a number outside the rails is refused where it is typed. Not-a-number
 * mid-edit leaves the form as it was (capFromField), rather than flipping the cap to the default underneath. */
const setCap = (field: `memoryGib` | `cpus`, event: Event): void => {
    const value = capFromField((event.target as HTMLInputElement).value);
    if (value !== undefined) {
        form.value = { ...form.value, [field]: value };
    }
};

// What an empty field means, said IN the field: the derived share is the ceiling the machine allows, so a
// measured engine can name the number; an unmeasured one can only name the rule.
const memoryPlaceholder = computed(() => (memory.value.max === undefined ? `default` : `default: ${memory.value.max}`));
const cpuPlaceholder = computed(() => (cpus.value.max === undefined ? `all` : `all ${cpus.value.max}`));

const uid = useId();
</script>

<template>
    <Modal :open="open" size="md" :header="`Resources for ${name}`" @update:open="emit(`cancel`)">
        <div v-if="current !== undefined" class="flex flex-col gap-4">
            <!-- The four rows share one bordered box, the shape <ExportBundleDialog> settled on for a control
                 with a sentence under it inside a modal: a modal's body padding is PrimeVue's, so rows drawn
                 flush against it would need a negative margin guessed against a number this file may not
                 assume. `flush` because the box is the surface, `compact` because it is a list of four. -->
            <div class="flex flex-col overflow-hidden rounded-lg border border-line divide-y divide-line-subtle">
                <!-- MEMORY. The field is whole GiB and EMPTY means the default, said by the placeholder rather
                     than by a second control: the derived share is what every sandbox runs on until somebody
                     types a number, so "back to the default" is deleting the number. -->
                <Row flush density="compact" icon="server" title="Memory" class="px-3.5 py-3" :tone="problems.memory === undefined ? `default` : `warning`">
                    <template #description>
                        Whole GiB, {{ memory.min }}<template v-if="memory.max !== undefined"> to {{ memory.max }}</template> on this computer. Empty is the
                        default: everything it has beyond what it keeps for itself.
                    </template>
                    <template #control>
                        <!-- The unit sits in a fixed, right-aligned span rather than as loose text: the two cap
                             fields are read as a column of numbers, and a unit that took its own width staggered
                             them by the difference between "GiB" and "cores". Both edges line up now. -->
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

                <!-- CPUs. Same field, and the default is the opposite kind of thing: no ceiling at all, every
                     core the engine has, which is how a sandbox has always run. A cap is for the machine that
                     rule is wrong about, a laptop whose owner wants to keep working while the sandbox builds. -->
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

                <!-- PRIVILEGED. Locked, with the reason, when the approved environment demands it: a reshape
                     can add to what the environment asks and withdraw only the owner's own ask, never the
                     environment's, and a switch that could be thrown and then silently ignored on Apply is the
                     drift the run contract stamps the container to make visible. -->
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

                <!-- GPU. The one switch whose ask and answer can disagree: a host without the NVIDIA runtime
                     drops the flag and the sandbox starts without it. The switch stays where the owner left it
                     and the row says what became of the ask, so Apply never re-requests what was never withdrawn. -->
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

            <!-- WHAT APPLYING COSTS, beside the button that commits it. Every sentence keeps the SANDBOX as its
                 subject: "it restarts on that computer" was read as the computer restarting, which is a far
                 bigger thing to be asked to agree to than what happens. -->
            <p class="text-xs text-muted">
                Applying restarts the sandbox onto the same image, about a minute, and interrupts whoever is working in it. Its files (in /work) are
                kept, and the new share survives every later update, rollback and rebuild.
            </p>
            <p v-if="selfWarning" class="text-xs text-warning">This is the sandbox you are using right now: this page will lose it until it is back.</p>
        </div>

        <template #footer>
            <Button label="Cancel" severity="secondary" :text="true" @click="emit(`cancel`)" />
            <!-- Disabled rather than refused: a form with nothing changed, or a cap outside the rails, has
                 nothing the machine would accept, and the row above already says which. Not danger-red: it
                 commits the sandbox to a restart and keeps its files, which is the swaps' own colour. -->
            <Button label="Apply" :disabled="!ready" @click="ask !== undefined && emit(`apply`, ask)">
                <template #icon><Icon name="bolt" /></template>
            </Button>
        </template>
    </Modal>
</template>
