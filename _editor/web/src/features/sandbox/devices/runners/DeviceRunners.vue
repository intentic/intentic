<script setup lang="ts">
import { computed, ref } from "vue";
import type { Device } from "@intentic/sandbox-contract";
import { Button, ConfirmDialog, DeviceRunLog, type NoticeModel, RowGroup, RowNote, StatusBadge, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import DeviceOpFailure from "./DeviceOpFailure.vue";
import { runnerFallback } from "./deviceFallback";
import { createRunner, removeRunner, syncRunnerSettings, updateRunner, useRunners } from "./useRunners";
import { useHubWork } from "../../../../shell/hub/hubWork";
import { useT } from "@intentic/ui/i18n";

// This sandbox's runners on one device: containers it keeps there to run agents (docs/remote-runners-plan.md),
// separate from the sandbox list above (workspaces belonging to a person). Only runners this sandbox asked for
// appear under a machine; one started by hand has no host recorded and no row here.

const t = useT();

const { device } = defineProps<{ device: Device }>();

const { runners, refetch } = useRunners();
const mine = computed(() => runners.value.filter((runner) => runner.host !== undefined && runner.host === device.hostId));

// Building or updating a container on somebody's laptop, so the Devices row carries it while the reader is
// elsewhere in the hub.
const hubWork = useHubWork();
const WORKING: Record<"create" | "remove" | "update", string> = { create: `Adding runner`, remove: `Removing runner`, update: `Updating runner` };

// One flow at a time on one machine, same rule the sandbox rows above follow.
const busy = ref<string | undefined>();
const lines = ref<string[]>([]);
// The notice, and the line that does the same thing on the machine itself when this route to it is shut.
const failure = ref<{ notice: NoticeModel; command?: string } | undefined>();
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

const run = async (op: "create" | "remove" | "update", name: string): Promise<void> => {
    if (device.hostId === undefined || busy.value !== undefined) {
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

const execute = async (op: "create" | "remove" | "update", name: string): Promise<void> => {
    if (device.hostId === undefined || busy.value !== undefined) {
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
        done.value = await flow(device.hostId, name, onLine);
    } catch (error) {
        failure.value = { notice: noticeFrom(error, `That didn't work on this device.`), command: runnerFallback(op, name) };
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
    <!-- "on this device", not "for this sandbox": this list sits under the machine's own sandbox list. -->
    <RowGroup
        v-if="device.hostId !== undefined"
        :label="t(`sandbox.deviceRunners.runnersOnDevice`)"
        :count="mine.length === 0 ? undefined : mine.length"
    >
        <template #actions>
            <Button
                v-if="!adding"
                size="small"
                severity="secondary"
                :text="true"
                :label="t(`sandbox.deviceRunners.addRunner`)"
                :disabled="busy !== undefined || device.online !== true"
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
                    <span class="text-2xs text-subtle">{{ facts(runner) }}</span>
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
                        :disabled="busy !== undefined || device.online !== true"
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
                        :disabled="busy !== undefined || device.online !== true"
                        @click="run(`remove`, runner.id)"
                    />
                </span>
            </li>
        </ul>

        <!-- Said where the list would be, since an empty surface with a heading reads as a failure to load. -->
        <RowNote v-if="mine.length === 0 && !adding" variant="empty">{{
            t(`sandbox.deviceRunners.sandboxKeepsNoRunner`, { label: device.label })
        }}</RowNote>

        <!-- The machine's own output while `ic` works, and whatever it said at the end. -->
        <RowNote v-if="busy !== undefined || failure || done" variant="block" class="flex flex-col gap-1">
            <DeviceRunLog
                v-if="busy !== undefined"
                :lines="lines"
                :running="true"
                :empty="t(`sandbox.deviceRunners.startingOnDevice`)"
                :note="t(`sandbox.deviceRunners.runningOnDeviceKeeps`)"
            />
            <DeviceOpFailure v-if="failure" :of="failure.notice" :command="failure.command" :machine="device.label" />
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
            <p>{{ t(`sandbox.deviceRunners.runnerComesOffWork`, { label: device.label }) }}</p>
        </ConfirmDialog>
    </RowGroup>
</template>
