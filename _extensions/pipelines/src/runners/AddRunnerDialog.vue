<script setup lang="ts">
import type { CiRepo } from "@intentic/sandbox-contract/schemas/ci";
import { Button, Modal, ui } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { t } from "../i18n.js";
import type { CiRunner } from "./fleetTypes";
import { defaultLabels, type FleetDevice, githubRepos, parseLabels, suggestRunnerName } from "./runnerFleet";

// Registering a new runner on one computer: its name (one past the highest worker there), its labels (the light lane's
// alone for a `-light-N` name, docs/ops/ci-runner.md), and the workspace repository whose GitHub remote it serves. The
// labels follow the name until the reader types their own.

const props = defineProps<{ device: FleetDevice; runners: readonly CiRunner[]; repos: readonly CiRepo[] }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ submit: [input: { repo: string; name: string; labels: string[] }] }>();

// The contract's own rule for a runner's name and a label (schemas/ci-fleet.ts CiRunnerNameSchema), checked before the
// press so a typo is said at the field rather than as the daemon's refusal.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const candidates = computed(() => githubRepos(props.repos));
const name = ref(``);
const labels = ref(``);
const labelsTouched = ref(false);
const repo = ref(``);

watch(
    open,
    (now) => {
        if (now) {
            name.value = suggestRunnerName(props.device, props.runners);
            labels.value = defaultLabels(name.value);
            labelsTouched.value = false;
            repo.value = candidates.value[0]?.repo ?? ``;
        }
    },
    { immediate: true },
);
watch(name, (next) => {
    if (!labelsTouched.value) {
        labels.value = defaultLabels(next);
    }
});

const parsed = computed(() => parseLabels(labels.value));
const nameOk = computed(() => NAME.test(name.value));
const labelsOk = computed(() => parsed.value.length > 0 && parsed.value.every((label) => NAME.test(label)));
const ready = computed(() => nameOk.value && labelsOk.value && repo.value !== ``);

const submit = (): void => {
    if (ready.value) {
        emit(`submit`, { repo: repo.value, name: name.value, labels: parsed.value });
        open.value = false;
    }
};
</script>

<template>
    <Modal v-model:open="open" size="md" :header="t(`runners.add.header`, { device: device.label })" :description="t(`runners.add.description`)">
        <form class="flex flex-col gap-3" @submit.prevent="submit()">
            <label class="flex flex-col gap-1 text-xs text-muted">
                {{ t(`runners.add.name`) }}
                <input v-model="name" :class="ui.input({ size: `sm` }, `font-mono`)" spellcheck="false" autocomplete="off" />
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted">
                {{ t(`runners.add.labels`) }}
                <input
                    v-model="labels"
                    :class="ui.input({ size: `sm` }, `font-mono`)"
                    spellcheck="false"
                    autocomplete="off"
                    @input="labelsTouched = true"
                />
                <span class="text-2xs text-subtle">{{ t(`runners.add.labelsHelp`) }}</span>
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted">
                {{ t(`runners.add.repo`) }}
                <select v-if="candidates.length > 0" v-model="repo" :class="ui.input({ size: `sm` })">
                    <option v-for="candidate in candidates" :key="candidate.repo" :value="candidate.repo">
                        {{ candidate.repo }} · {{ candidate.project }}
                    </option>
                </select>
                <span v-else class="text-2xs text-danger">{{ t(`runners.add.noRepo`) }}</span>
            </label>
            <div class="flex justify-end gap-2">
                <Button type="button" tier="quiet" size="small" :label="t(`runners.add.cancel`)" @click="open = false" />
                <Button type="submit" tier="accent" size="small" :label="t(`runners.add.submit`)" :disabled="!ready" />
            </div>
        </form>
    </Modal>
</template>
