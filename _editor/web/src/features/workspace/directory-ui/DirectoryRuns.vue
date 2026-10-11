<script setup lang="ts">
import { RUN_TARGETS_FILE } from "@intentic/sandbox-contract";
import { Button, ui, Icon, Modal, toneDot } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { useT } from "@intentic/ui/i18n";
import { useWorkspaceTabs } from "../tabs/useWorkspaceTabs";
import { useRunTargets } from "./useRunTargets";

const t = useT();

/* WHAT THIS REPOSITORY CAN RUN ON YOUR COMPUTERS, opened from its own row in the tree. Where it runs is chosen once,
   above the list, where every computer shows whether it can take a run; each target the run-targets file declares is
   then one row with one Run button. A run opens the terminal it happens in. */

const dir = defineModel<string | undefined>({ required: true });

const { repos, devices, pending, failure, run } = useRunTargets();
const { openFile } = useWorkspaceTabs();

const visible = computed({
    get: () => dir.value !== undefined,
    set: (open: boolean) => {
        if (!open) {
            dir.value = undefined;
        }
    },
});

const entry = computed(() => (repos.value ?? []).find((candidate) => candidate.repo === dir.value));

type Device = (typeof devices.value)[number];

// Why a computer cannot take a run now, said under the picker when it is the chosen one; undefined when it can.
const blocked = (device: Device): string | undefined => {
    if (!device.online) {
        return t(`workspace.directoryRuns.offline`, { device: device.id });
    }
    if (!device.programs) {
        return t(`workspace.directoryRuns.agentTooOld`, { device: device.id });
    }
    return device.allowed ? undefined : t(`workspace.directoryRuns.switchOff`, { device: device.id });
};

// The dot beside a computer's name: filled when connected (ready, or refusing runs until something is changed there),
// a hollow ring when asleep. Shape carries the difference as well as hue, since a skin's muted tones are close at 6px.
const DOT = `size-1.5 shrink-0 rounded-full`;
const dot = (device: Device): string =>
    !device.online ? `${DOT} border border-subtle` : toneDot(blocked(device) === undefined ? `success` : `warning`, DOT);

// By name, so a computer keeps its place in the row whichever is chosen.
const sorted = computed(() => devices.value.toSorted((a, b) => a.id.localeCompare(b.id)));

// The computer the file names first if it can take a run, else any that can, else the first: the button a reader most
// likely wants is the one already chosen.
const fallback = computed((): string | undefined => {
    const ready = sorted.value.filter((device) => blocked(device) === undefined);
    const named = (entry.value?.targets ?? []).map((target) => target.device).find((id) => ready.some((device) => device.id === id));
    return named ?? ready[0]?.id ?? sorted.value[0]?.id;
});
const picked = ref<string | undefined>(undefined);
// Opening another repository's runs starts from its own default, not the last one's choice.
watch(dir, () => {
    picked.value = undefined;
});
const chosen = computed(() => sorted.value.find((device) => device.id === (picked.value ?? fallback.value)));
const chosenBlocked = computed(() => (chosen.value === undefined ? undefined : blocked(chosen.value)));

const isPending = (target: string): boolean =>
    pending.value !== undefined &&
    pending.value.repo === entry.value?.repo &&
    pending.value.target === target &&
    pending.value.device === chosen.value?.id;

const editFile = (path: string): void => {
    dir.value = undefined;
    openFile(path);
};

const fileName = RUN_TARGETS_FILE.split(`/`).at(-1) ?? RUN_TARGETS_FILE;

const EXAMPLE = `{
  "targets": [{
    "name": "app",
    "device": "my-pc",
    "build": "cargo xwin build --release --target x86_64-pc-windows-msvc",
    "artifact": "target/x86_64-pc-windows-msvc/release/app.exe"
  }]
}`;
</script>

<template>
    <Modal v-model:open="visible" size="md" :header="t(`workspace.directoryRuns.runIn`, { dir: dir ?? `` })">
        <div class="flex flex-col gap-4">
            <template v-if="entry !== undefined">
                <!-- Where: one choice for every target below, each computer with its state as a dot. -->
                <div v-if="sorted.length > 0" class="flex flex-col gap-2">
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <span id="directory-runs-computer" class="text-xs text-subtle">{{ t(`workspace.directoryRuns.computer`) }}</span>
                        <div role="radiogroup" aria-labelledby="directory-runs-computer" class="flex flex-wrap items-center gap-1">
                            <button
                                v-for="device in sorted"
                                :key="device.id"
                                type="button"
                                role="radio"
                                :aria-checked="device.id === chosen?.id"
                                :class="[
                                    `touch-target flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors`,
                                    device.id === chosen?.id ? `ui-pill-on` : device.online ? `text-muted hover:text-content` : `text-subtle hover:text-content`,
                                ]"
                                @click="picked = device.id"
                            >
                                <span :class="dot(device)" aria-hidden="true" />
                                {{ device.id }}
                            </button>
                        </div>
                    </div>
                    <p v-if="chosen !== undefined && chosenBlocked !== undefined" class="text-xs" :class="chosen.online ? `text-warning` : `text-muted`">
                        {{ chosenBlocked }}
                        <RouterLink v-if="chosen.online" :to="`/capabilities/${chosen.id}`" class="ml-1 text-link hover:underline">{{
                            t(`workspace.directoryRuns.openCard`)
                        }}</RouterLink>
                    </p>
                </div>
                <p v-else class="text-sm text-muted">
                    {{ t(`workspace.directoryRuns.noComputers`) }}
                    <RouterLink to="/capabilities" class="ml-1 text-link hover:underline">{{ t(`workspace.directoryRuns.connectOne`) }}</RouterLink>
                </p>

                <p v-if="entry.error !== undefined" class="text-sm text-danger">{{ entry.error }}</p>

                <!-- What: the targets, flat on the dialog's own surface, one Run each. -->
                <ul class="flex flex-col divide-y divide-line-subtle border-t border-line-subtle">
                    <li v-for="target in entry.targets" :key="target.name" class="flex items-center gap-4 py-3">
                        <div class="flex min-w-0 flex-1 flex-col gap-1">
                            <div class="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                                <span class="font-mono text-sm text-content">{{ target.name }}</span>
                                <span v-if="target.isolated" class="inline-flex items-center gap-1 text-2xs text-subtle">
                                    <Icon name="shield" />{{ t(`workspace.directoryRuns.isolated`) }}
                                </span>
                            </div>
                            <p v-if="target.description !== undefined" class="text-xs leading-relaxed text-muted">{{ target.description }}</p>
                        </div>
                        <Button
                            class="shrink-0"
                            :label="t(`workspace.directoryRuns.run`)"
                            :aria-label="chosen === undefined ? undefined : t(`workspace.directoryRuns.runOn`, { target: target.name, device: chosen.id })"
                            :title="chosen === undefined ? undefined : t(`workspace.directoryRuns.runTip`, { device: chosen.id })"
                            tier="boring"
                            size="small"
                            :disabled="chosen === undefined || chosenBlocked !== undefined"
                            :loading="isPending(target.name)"
                            @click="run(entry!.repo, target.name, chosen!.id)"
                        >
                            <template #icon><Icon name="play" class="mr-1.5 text-2xs" /></template>
                        </Button>
                    </li>
                </ul>
                <p v-if="failure !== undefined" class="-mt-2 text-xs text-danger">{{ failure }}</p>
            </template>

            <template v-else>
                <p class="text-sm text-muted">
                    {{ t(`workspace.directoryRuns.declaresNothing`) }}
                    <span class="font-mono text-content">{{ dir }}/{{ RUN_TARGETS_FILE }}</span>
                </p>
                <pre class="overflow-x-auto rounded-lg bg-canvas px-3 py-2 font-mono text-2xs text-content">{{ EXAMPLE }}</pre>
            </template>
        </div>

        <template #footer>
            <!-- The file is the source of truth and lives in the repository; the switches a run needs live on the cards. -->
            <button v-if="entry !== undefined" type="button" :class="ui.textButton({ tone: `quiet` }, `mr-auto`)" :title="entry.path" @click="editFile(entry.path)">
                <Icon name="file-edit" class="text-2xs" />{{ t(`workspace.directoryRuns.editFile`, { file: fileName }) }}
            </button>
            <RouterLink to="/capabilities" :class="ui.textButton({ tone: `quiet` }, entry === undefined ? `mr-auto` : ``)">
                {{ t(`workspace.directoryRuns.yourComputers`) }} <Icon name="arrow-right" class="text-2xs" />
            </RouterLink>
        </template>
    </Modal>
</template>
