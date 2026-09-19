<script setup lang="ts">
import { syncFolder } from "@intentic/sandbox-contract";
import { Button, type DeviceSandboxGroup, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import type { DeviceOps } from "../runners/deviceOps";
import { type DeviceRow, managerOf, type MachineRow } from "../deviceRows";
import { environmentTitle } from "../machineEnvironments";
import { useSandbox } from "../../client/useSandbox";
import { useT } from "@intentic/ui/i18n";

// TURNING SYNC ON WHERE IT IS READ ABOUT. A machine already connected needs no one-liner to start syncing a folder:
// the switches that pause, unpair and mirror live on this row already, and the one that STARTS it belongs beside them.
// The add-a-device dialog keeps the paste path, for a machine with no door yet.
//
// A row per environment, because the folder is the choice: mutagen can only watch the filesystem that holds it, so a
// `C:\…` path syncs the Windows side and a `/home/…` path the distro. Every button fires at the machine's open door
// and the daemon routes the line by that folder (hosts/device-commands.ts) — nothing here picks a side, and nothing
// asks the reader to.

const t = useT();

const { machine, group, ops } = defineProps<{
    machine: MachineRow;
    group: DeviceSandboxGroup;
    /** This page's own ops, so an answer lands under the row it was pressed on. */
    ops: DeviceOps;
}>();

const { active, daemonUrl } = useSandbox();

// The door the line is SENT to: the one container verbs already use. Absent means a machine with no commands, where
// there is nothing to press.
const door = computed(() => managerOf(machine));

// Every environment that could hold the folder. A sync-only row is one: its own agent is what would run mutagen, and
// the daemon reaches it by crossing from the door above.
const choices = computed(() => machine.environments.filter((environment) => environment.device.facts?.home !== undefined));

// The folder this environment would sync into, spelled in its own filesystem — which is the whole point: the path
// says which side of the machine the files land on. Falls back to the tilde form the add-a-device card suggests.
const suggestion = (environment: DeviceRow): string => {
    const home = environment.device.facts?.home;
    const name = active.value?.name ?? `sandbox`;
    if (home === undefined) {
        return syncFolder(name, daemonUrl.value);
    }
    const windows = home.includes(`\\`);
    const leaf = syncFolder(name, daemonUrl.value).replace(/^~\//, ``);
    return `${home}${windows ? `\\` : `/`}${windows ? leaf.replaceAll(`/`, `\\`) : leaf}`;
};

// The OS name plus the distro's own, because two distros of one PC can run the same OS: "Arch Linux" twice is two
// labels a reader cannot choose between, and the registered name is what tells them apart everywhere else.
const environmentLabel = (environment: DeviceRow): string => {
    const distro = (environment.device.facts?.wsl ?? environment.device.report?.wsl)?.distro;
    const title = environmentTitle(environment);
    return distro === undefined || title.includes(distro) ? title : `${title} · ${distro}`;
};

// One editable folder per environment, seeded from its suggestion and kept as typed.
const folders = ref<Record<string, string>>({});
const folderFor = (environment: DeviceRow): string => folders.value[environment.device.key] ?? suggestion(environment);
const setFolder = (environment: DeviceRow, value: string): void => void (folders.value = { ...folders.value, [environment.device.key]: value });

const key = computed(() => ops.rowKey(group));

const enable = (environment: DeviceRow, mode: "sync" | "mirror"): void => {
    const target = door.value;
    if (target === undefined) {
        return;
    }
    void ops.runSync(target, key.value, group.sandboxId, `sync-install`, mode === `mirror` ? { mode } : { mode, localDir: folderFor(environment) });
};
</script>

<template>
    <div v-if="door" class="mt-2 flex flex-col gap-2">
        <p class="text-2xs text-subtle">
            {{ t(`sandbox.sandboxSyncToggles.syncSandboxsFilesInto`) }}
        </p>
        <!-- The field's basis is what makes the BUTTON wrap on a narrow card rather than the input shrink: a path you
             cannot read while typing it is the one thing this field must never be. -->
        <div v-for="environment in choices" :key="`sync:${environment.device.key}`" class="flex flex-wrap items-end gap-2">
            <div class="flex min-w-64 flex-1 flex-col gap-1">
                <label class="text-2xs font-medium text-muted" :for="`sync-folder-${environment.device.key}`">
                    {{ environmentLabel(environment) }}
                </label>
                <input
                    :id="`sync-folder-${environment.device.key}`"
                    :value="folderFor(environment)"
                    spellcheck="false"
                    :class="ui.inputSm(`w-full font-mono`)"
                    @input="setFolder(environment, ($event.target as HTMLInputElement).value)"
                />
            </div>
            <Button
                size="small"
                :label="t(`sandbox.sandboxSyncToggles.syncFilesHere`)"
                :loading="ops.syncRunning(key, `sync-install`)"
                :disabled="ops.working.value || folderFor(environment).trim() === ``"
                v-tooltip.top="t(`sandbox.sandboxSyncToggles.startMovingSandboxsFiles`)"
                @click="enable(environment, `sync`)"
            >
                <template #icon><Icon name="folder" /></template>
            </Button>
        </div>
        <!-- Ports without files: one machine may mirror while another holds the file sync, so this is its own act. -->
        <div class="flex flex-wrap items-center gap-2">
            <Button
                size="small"
                severity="secondary"
                :label="t(`sandbox.sandboxSyncToggles.mirrorPortsOnly`)"
                :loading="ops.syncRunning(key, `sync-install`)"
                :disabled="ops.working.value"
                v-tooltip.top="t(`sandbox.sandboxSyncToggles.putSandboxsPortsOn`)"
                @click="enable(choices[0] ?? machine.environments[0]!, `mirror`)"
            >
                <template #icon><Icon name="ports" /></template>
            </Button>
        </div>
    </div>
</template>
