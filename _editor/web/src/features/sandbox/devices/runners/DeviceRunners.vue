<script setup lang="ts">
import { computed, ref } from "vue";
import { Button, ConfirmDialog, DeviceRunLog, RowGroup, RowNote, StatusBadge, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import DeviceOpFailure from "./DeviceOpFailure.vue";
import { type RunnerFailure, type RunnerOp, runnerFailure } from "./runnerFailure";
import { createRunner, removeRunner, syncRunnerSettings, updateRunner, useRunners } from "./useRunners";
import { type DeviceRow, type MachineRow, managerOf } from "../deviceRows";
import { environmentTitle } from "../machineEnvironments";
import { useHubWork } from "../../../../shell/hub/hubWork";
import { useT } from "@intentic/ui/i18n";

// This sandbox's runners on one MACHINE: containers it keeps there to run agents,
// separate from the sandbox list above (workspaces belonging to a person). Only runners this sandbox asked for
// appear under a machine; one started by hand has no host recorded and no row here.
//
// One group per PC, not per door. A machine drawn once per environment drew this heading twice, with two
// near-identical empty states under it — and there was never a second list to show: one Docker engine serves every
// door on a PC, so a runner reached through the Windows side and one reached through a distro are the same
// container. Which door created a runner is a fact about the runner, said on its row when there is more than one.

const t = useT();

const { machine } = defineProps<{ machine: MachineRow }>();

// Where a new runner is built: the door the container verbs already go through. A machine with none has nothing
// to press, which is what disables the button below.
const door = computed(() => managerOf(machine));

// Every environment's own door, so a runner created through either side is listed once under the PC.
const doors = computed(
    () => new Map(machine.environments.flatMap((row): [string, DeviceRow][] => (row.device.hostId === undefined ? [] : [[row.device.hostId, row]]))),
);

const { runners, refetch } = useRunners();
const mine = computed(() => runners.value.filter((runner) => runner.host !== undefined && doors.value.has(runner.host)));

// Which side of a many-sided PC a runner was built through; silent on a machine with one door, where it would
// name the only thing it could.
const builtOn = (host: string | undefined): string | undefined => {
    const row = host === undefined ? undefined : doors.value.get(host);
    return machine.environments.length > 1 && row !== undefined ? environmentTitle(row) : undefined;
};

// Building or updating a container on somebody's laptop, so the Devices row carries it while the reader is
// elsewhere in the hub.
const hubWork = useHubWork();
const WORKING: Record<RunnerOp, string> = { create: `Adding runner`, remove: `Removing runner`, update: `Updating runner` };

// One flow at a time on one machine, same rule the sandbox rows above follow.
const busy = ref<string | undefined>();
const lines = ref<string[]>([]);
// The notice, and the line that does the same thing on the machine itself when this route to it is shut.
const failure = ref<RunnerFailure | undefined>();
const done = ref<string | undefined>();

const facts = (runner: { online: boolean; facts?: { cpus: number; memoryMb: number; load: number } }): string => {
    if (!runner.online) {
        return `Offline — asleep, or its container is down`;
    }
    return runner.facts === undefined
        ? `Ready`
        : `${runner.facts.cpus} cores · ${Math.round(runner.facts.memoryMb / 1024)} GB · load ${runner.facts.load.toFixed(2)}`;
};

// Parity drift lines from the daemon: a "Setting …" line is fixable via Sync; others need a rebuild
// (remove and re-add).
const driftSummary = (runner: { drift?: { subject: string; detail: string }[] }): string | undefined => {
    if (runner.drift === undefined || runner.drift.length === 0) {
        return undefined;
    }
    return `Differs from this sandbox: ${runner.drift.map((line) => line.subject).join(", ")}`;
};
const driftDetail = (runner: { drift?: { subject: string; detail: string }[] }): string =>
    (runner.drift ?? []).map((line) => `${line.subject} — ${line.detail}`).join("\n");
const syncable = (runner: { online: boolean; drift?: { subject: string }[] }): boolean =>
    runner.online && (runner.drift ?? []).some((line) => line.subject.startsWith(`Setting `));

const syncing = ref<string | undefined>();
const sync = async (id: string): Promise<void> => {
    if (syncing.value !== undefined) {
        return;
    }
    syncing.value = id;
    failure.value = undefined;
    try {
        await syncRunnerSettings(id);
    } catch (error) {
        // No line of its own: a runner's settings are pushed over this door and have no CLI verb behind them.
        failure.value = { notice: noticeFrom(error, `The settings didn't reach that runner.`) };
    } finally {
        syncing.value = undefined;
        refetch();
    }
};

// Asked for rather than generated, since it's what the placement picker shows: lowercase letters, digits and
// dashes, what `ic` accepts.
// Removal parks here until the app's own dialog answers, rather than the browser's confirm().
const confirmingRemove = ref<string | undefined>();
const removeHeader = computed(() => `Remove runner "${confirmingRemove.value ?? ``}"?`);

const run = async (op: RunnerOp, name: string): Promise<void> => {
    if (door.value?.device.hostId === undefined || busy.value !== undefined) {
        return;
    }
    if (op === "remove") {
        confirmingRemove.value = name;
        return;
    }
    await execute(op, name);
};

const removeConfirmed = async (): Promise<void> => {
    const name = confirmingRemove.value;
    confirmingRemove.value = undefined;
    if (name !== undefined) {
        await execute("remove", name);
    }
};

const execute = async (op: RunnerOp, name: string): Promise<void> => {
    const host = door.value?.device.hostId;
    if (host === undefined || busy.value !== undefined) {
        return;
    }
    busy.value = name;
    failure.value = undefined;
    done.value = undefined;
    lines.value = [];
    const endMark = hubWork.begin(`${WORKING[op]} ${name}`);
    try {
        const onLine = (line: string): void => void (lines.value = [...lines.value, line]);
        const flow = { create: createRunner, remove: removeRunner, update: updateRunner }[op];
        done.value = await flow(host, name, onLine);
    } catch (error) {
        failure.value = runnerFailure(op, name, machine.label, error, lines.value);
    } finally {
        busy.value = undefined;
        endMark();
        refetch();
    }
};

const asked = ref("");
const adding = ref(false);
const nameError = computed(() =>
    asked.value !== "" && !/^[a-z0-9-]+$/.test(asked.value) ? `Lowercase letters, digits and dashes only.` : undefined,
);

const add = async (): Promise<void> => {
    if (asked.value === "" || nameError.value !== undefined) {
        return;
    }
    const name = asked.value;
    asked.value = "";
    adding.value = false;
    await run("create", name);
};
</script>

<template>
    <!-- The page is the machine, so the heading is the noun alone: this list sits under its own sandbox list. -->
    <RowGroup v-if="door" :label="t(`sandbox.deviceRunners.runners`)" :count="mine.length > 0 ? mine.length : undefined">
        <template #actions>
            <Button
                v-if="!adding"
                size="small"
                severity="secondary"
                :text="true"
                :label="t(`sandbox.deviceRunners.addRunner`)"
                :disabled="busy !== undefined || door.device.online !== true"
                @click="adding = true"
            >
                <template #icon><Icon name="plus" /></template>
            </Button>
        </template>

        <!-- Asked for, not generated: it's what you pick from in the composer every day. -->
        <RowNote v-if="adding" variant="block" class="flex flex-wrap items-center gap-2">
            <input
                v-model="asked"
                type="text"
                :placeholder="t(`sandbox.deviceRunners.nameEGRog`)"
                :class="ui.inputSm(`w-44`)"
                @keydown.enter.prevent="add()"
                @keydown.esc.prevent="adding = false"
            />
            <Button size="small" :label="t(`ui.action.create`)" :disabled="asked === `` || nameError !== undefined" @click="add()" />
            <Button size="small" severity="secondary" :text="true" :label="t(`ui.action.cancel`)" @click="adding = false" />
            <span v-if="nameError" class="text-2xs text-danger">{{ nameError }}</span>
        </RowNote>

        <ul v-if="mine.length > 0" class="flex flex-col">
            <li v-for="runner in mine" :key="runner.id" class="flex items-center gap-2 px-4 py-2.5">
                <Icon name="desktop" class="text-xs" :class="runner.online ? 'text-primary-500' : 'text-subtle'" />
                <span class="flex min-w-0 flex-col">
                    <span class="truncate text-xs text-content">{{ runner.id }}</span>
                    <!-- Which side it was built through, only where a PC has more than one. -->
                    <span class="text-2xs text-subtle"
                        >{{ facts(runner) }}<template v-if="builtOn(runner.host)"> · {{ builtOn(runner.host) }}</template></span
                    >
                    <!-- Detail rides the tooltip so the row stays one glance. -->
                    <span v-if="driftSummary(runner)" class="truncate text-2xs text-warning" :title="driftDetail(runner)">
                        {{ driftSummary(runner) }}
                    </span>
                </span>
                <StatusBadge v-if="!runner.online" variant="neutral" size="xs" :label="t(`sandbox.deviceRunners.offline`)" />
                <!-- A runner behind the parent runs fine until it doesn't, then fails as a link error rather than an old machine; drift is said here instead. -->
                <StatusBadge v-else-if="runner.parity === `outdated`" variant="warning" size="xs" :label="t(`sandbox.deviceRunners.outdated`)" />
                <!-- Update rebuilds an outdated container; Sync pushes the fixable half over the runner's live link. -->
                <span class="ml-auto flex items-center gap-1">
                    <Button
                        v-if="runner.parity === `outdated` && runner.online"
                        size="small"
                        severity="secondary"
                        :label="t(`ui.action.update`)"
                        :disabled="busy !== undefined || door.device.online !== true"
                        @click="run(`update`, runner.id)"
                    />
                    <Button
                        v-if="syncable(runner)"
                        size="small"
                        severity="secondary"
                        :text="true"
                        :label="syncing === runner.id ? t(`sandbox.deviceRunners.syncing`) : t(`sandbox.deviceRunners.syncSettings`)"
                        :disabled="syncing !== undefined || busy !== undefined"
                        @click="sync(runner.id)"
                    />
                    <Button
                        size="small"
                        severity="secondary"
                        :text="true"
                        :label="t(`ui.action.remove`)"
                        :disabled="busy !== undefined || door.device.online !== true"
                        @click="run(`remove`, runner.id)"
                    />
                </span>
            </li>
        </ul>

        <!-- Said where the list would be, since an empty surface with a heading reads as a failure to load. -->
        <RowNote v-if="mine.length === 0 && !adding" variant="empty">{{
            t(`sandbox.deviceRunners.sandboxKeepsNoRunner`, { label: machine.label })
        }}</RowNote>

        <!-- The machine's own output while `ic` works, kept after a failure as the record of how far it got. -->
        <RowNote v-if="busy !== undefined || failure || done" variant="block" class="flex flex-col gap-1">
            <DeviceRunLog
                v-if="busy !== undefined || (failure !== undefined && lines.length > 0)"
                :lines="lines"
                :running="busy !== undefined"
                :empty="t(`sandbox.deviceRunners.startingOnDevice`)"
                :note="t(`shared.runningOnDeviceKeeps`)"
            />
            <DeviceOpFailure v-if="failure" :of="failure.notice" :command="failure.command" :machine="machine.label" />
            <p v-else-if="done" class="text-xs text-muted">{{ done }}</p>
        </RowNote>

        <ConfirmDialog
            :open="confirmingRemove !== undefined"
            :header="removeHeader"
            :confirm-label="t(`ui.action.remove`)"
            confirm-icon="trash"
            @cancel="confirmingRemove = undefined"
            @confirm="removeConfirmed"
        >
            <p>{{ t(`sandbox.deviceRunners.runnerComesOffWork`, { label: machine.label }) }}</p>
        </ConfirmDialog>
    </RowGroup>
</template>
