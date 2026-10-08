<script setup lang="ts">
import { syncFolder } from "@intentic/sandbox-contract";
import { Button, type DeviceSandboxGroup, ui } from "@intentic/ui";
import { computed, onUnmounted, ref } from "vue";
import type { DeviceOps } from "../runners/deviceOps";
import { type DeviceRow, managerOf, type MachineRow } from "../deviceRows";
import { environmentTitle } from "../machineEnvironments";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { useT } from "@intentic/ui/i18n";
import { beginSetup, draftFolder, pendingSetup, setDraftFolder } from "./syncSetup";

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

// One editable folder per environment, seeded from its suggestion and kept as typed, outside this component: setting a
// folder up restarts the machine's agent, which remounts this row while the press is still out (syncSetup.ts).
const folderFor = (environment: DeviceRow): string => draftFolder(machine.key, group.sandboxId, environment.device.key) ?? suggestion(environment);
const setFolder = (environment: DeviceRow, value: string): void => setDraftFolder(machine.key, group.sandboxId, environment.device.key, value);

// A setup of this row in flight, from this mount or one before it: the folder it was given, said back while it works.
const pending = computed(() => pendingSetup(machine.key, group.sandboxId));
// Seconds since it began, so a setup that takes minutes reads as one still going rather than one that stalled.
const now = ref(Date.now());
const ticker = setInterval(() => void (now.value = Date.now()), 1000);
onUnmounted(() => clearInterval(ticker));
const elapsed = computed(() => {
    const seconds = Math.max(0, Math.floor((now.value - (pending.value?.startedAt ?? now.value)) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, `0`)}`;
});

// The field's floor: the path it holds (one monospace `ch` a character, a spare one for the caret, and the field's own
// padding and border), never under 16rem and never past the line. A fixed floor let a typical path scroll out of its own
// field while the button still fitted beside it.
const fieldFloor = (environment: DeviceRow): string =>
    `min(100%, max(16rem, calc(${folderFor(environment).length + 1}ch + 2 * var(--ui-field-padding-x-sm) + 2px)))`;

const key = computed(() => ops.rowKey(group));

const enable = async (environment: DeviceRow, mode: "sync" | "mirror"): Promise<void> => {
    const target = door.value;
    if (target === undefined || ops.working.value) {
        return;
    }
    const folder = folderFor(environment).trim();
    const end = beginSetup(machine.key, group.sandboxId, { folder, mode });
    const rowKey = key.value;
    try {
        await ops.runSync(target, rowKey, group.sandboxId, `sync-install`, mode === `mirror` ? { mode } : { mode, localDir: folder });
    } finally {
        // A refused setup keeps the folder as typed, to correct and press again.
        end(ops.failure.value?.key !== rowKey);
    }
};
</script>

<template>
    <!-- WHILE IT SETS UP: the folder it was given, said back, and why it takes a while. The machine's agent restarts
         partway through, so the computer reading as reconnecting is expected rather than a failure. -->
    <div v-if="door && pending" class="flex flex-col gap-1" role="status">
        <p class="flex min-h-6.5 items-center gap-1.5 text-xs">
            <Icon name="spinner" spin class="shrink-0" aria-hidden="true" />
            <span v-if="pending.mode === `mirror`">{{ t(`sandbox.sandboxSyncToggles.settingUpMirror`) }}</span>
            <span v-else class="min-w-0">
                {{ t(`sandbox.sandboxSyncToggles.settingUpInto`) }}
                <code class="font-mono break-all">{{ pending.folder }}</code>
            </span>
            <span class="ml-auto shrink-0 text-subtle tabular-nums">{{ elapsed }}</span>
        </p>
        <p class="text-2xs text-subtle">{{ t(`sandbox.sandboxSyncToggles.settingUpNote`) }}</p>
    </div>
    <div v-else-if="door" class="flex flex-col gap-2">
        <!-- One button tall, so the sentence sits on the line of the name beside it. The field labels below say which
             side each folder syncs through, so the sentence no longer has to explain the rule. -->
        <p class="flex min-h-6.5 items-center text-xs text-muted">{{ t(`sandbox.sandboxSyncToggles.notSyncedHere`) }}</p>
        <!-- The field's floor is what makes the BUTTON wrap on a narrow card rather than the input shrink: a path you
             cannot read while typing it is the one thing this field must never be. -->
        <div v-for="environment in choices" :key="`sync:${environment.device.key}`" class="flex flex-col gap-1">
            <!-- Named only where there is a choice of side: on a machine of one environment it would name the page. -->
            <label v-if="choices.length > 1" class="text-2xs text-subtle" :for="`sync-folder-${environment.device.key}`">
                {{ environmentLabel(environment) }}
            </label>
            <div class="flex flex-wrap items-center gap-2">
                <input
                    :id="`sync-folder-${environment.device.key}`"
                    :value="folderFor(environment)"
                    spellcheck="false"
                    :aria-label="choices.length > 1 ? undefined : t(`sandbox.sandboxSyncToggles.folderOnComputer`)"
                    :class="ui.input({ size: `sm` }, `flex-1 font-mono`)"
                    :style="{ minWidth: fieldFloor(environment) }"
                    @input="setFolder(environment, ($event.target as HTMLInputElement).value)"
                />
                <Button
                    size="small"
                    :label="t(`sandbox.sandboxSyncToggles.syncFilesHere`)"
                    :disabled="ops.working.value || folderFor(environment).trim() === ``"
                    v-tooltip.top="{ title: t(`sandbox.sandboxSyncToggles.filesAndPorts`), note: t(`sandbox.sandboxSyncToggles.portsOntoLocalhost`) }"
                    @click="void enable(environment, `sync`)"
                >
                    <template #icon><Icon name="folder" /></template>
                </Button>
            </div>
        </div>
        <!-- Ports without files: one machine may mirror while another holds the file sync, so this is its own act. -->
        <div class="flex flex-wrap items-center">
            <Button
                size="small"
                tier="boring"
                :label="t(`sandbox.sandboxSyncToggles.mirrorPortsOnly`)"
                :disabled="ops.working.value"
                v-tooltip.top="{ title: t(`sandbox.words.ontoLocalhost`), note: t(`sandbox.sandboxSyncToggles.noFilesTouched`) }"
                @click="void enable(choices[0] ?? machine.environments[0]!, `mirror`)"
            >
                <template #icon><Icon name="ports" /></template>
            </Button>
        </div>
    </div>
</template>
