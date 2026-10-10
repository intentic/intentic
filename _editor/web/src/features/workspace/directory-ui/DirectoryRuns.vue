<script setup lang="ts">
import { RUN_TARGETS_FILE } from "@intentic/sandbox-contract";
import { Button, ui, Icon, Modal } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useT } from "@intentic/ui/i18n";
import { useRunTargets } from "./useRunTargets";

const t = useT();

/* WHAT THIS REPOSITORY CAN RUN ON YOUR COMPUTERS, opened from its own row in the tree: each target its
   the run-targets file declares, and a button per computer. A run opens the terminal it happens in. */

const dir = defineModel<string | undefined>({ required: true });

const { repos, devices, pending, failure, run } = useRunTargets();

const visible = computed({
    get: () => dir.value !== undefined,
    set: (open: boolean) => {
        if (!open) {
            dir.value = undefined;
        }
    },
});

const entry = computed(() => (repos.value ?? []).find((candidate) => candidate.repo === dir.value));

// Why a computer cannot take a run now, in the words its card uses; undefined when it can.
const blocked = (device: (typeof devices.value)[number]): string | undefined => {
    if (!device.online) {
        return t(`workspace.directoryRuns.offline`);
    }
    if (!device.programs) {
        return t(`workspace.directoryRuns.agentTooOld`);
    }
    return device.allowed ? undefined : t(`workspace.directoryRuns.switchOff`);
};

// The target's own computer first, then the rest by name: the button a reader most likely wants leads.
const devicesFor = (preferred: string | undefined) =>
    devices.value.toSorted((a, b) => Number(b.id === preferred) - Number(a.id === preferred) || a.id.localeCompare(b.id));

const isPending = (target: string, device: string): boolean =>
    pending.value !== undefined && pending.value.repo === entry.value?.repo && pending.value.target === target && pending.value.device === device;

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
                <i18n-t keypath="workspace.directoryRuns.declaredIn" tag="p" class="text-xs text-subtle" scope="global">
                    <template #path
                        ><code class="ui-code">{{ entry.path }}</code></template
                    >
                </i18n-t>
                <p v-if="entry.error !== undefined" class="text-sm text-danger">{{ entry.error }}</p>
                <p v-if="devices.length === 0" class="text-sm text-muted">{{ t(`workspace.directoryRuns.noComputers`) }}</p>
                <div v-for="target in entry.targets" :key="target.name" class="flex flex-col gap-2 rounded-lg border border-line px-3 py-2.5">
                    <div class="flex items-baseline gap-2">
                        <span class="font-mono text-sm text-content">{{ target.name }}</span>
                        <span v-if="target.isolated" class="text-2xs text-subtle">{{ t(`workspace.directoryRuns.isolated`) }}</span>
                    </div>
                    <p v-if="target.description !== undefined" class="text-xs text-muted">{{ target.description }}</p>
                    <div class="flex flex-wrap items-center gap-2">
                        <template v-for="device in devicesFor(target.device)" :key="device.id">
                            <Button
                                :label="t(`workspace.directoryRuns.runOn`, { device: device.id })"
                                :tier="device.id === target.device ? `accent` : `boring`"
                                size="small"
                                :disabled="blocked(device) !== undefined"
                                :loading="isPending(target.name, device.id)"
                                :title="blocked(device)"
                                @click="run(entry!.repo, target.name, device.id)"
                            >
                                <template #icon><Icon name="play" class="mr-1.5 text-2xs" /></template>
                            </Button>
                        </template>
                    </div>
                </div>
                <p v-if="failure !== undefined" class="text-xs text-danger">{{ failure }}</p>
                <p class="text-2xs text-subtle">{{ t(`workspace.directoryRuns.howItRuns`) }}</p>
            </template>

            <template v-else>
                <p class="text-sm text-muted">
                    {{ t(`workspace.directoryRuns.declaresNothing`) }}
                    <span class="font-mono text-content">{{ dir }}/{{ RUN_TARGETS_FILE }}</span>
                </p>
                <pre class="overflow-x-auto rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-2xs text-content">{{ EXAMPLE }}</pre>
            </template>
        </div>

        <template #footer>
            <!-- Where a computer's switches live: a run needs "Run programs this sandbox sends" on. -->
            <RouterLink to="/capabilities" :class="ui.textButton({ tone: `quiet` }, `mr-auto`)">
                {{ t(`workspace.directoryRuns.yourComputers`) }} <Icon name="arrow-right" class="text-2xs" />
            </RouterLink>
            <Button :label="t(`ui.action.close`)" tier="quiet" tone="accent" size="small" @click="dir = undefined" />
        </template>
    </Modal>
</template>
