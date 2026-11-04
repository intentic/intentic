<script setup lang="ts">
import { computed, ref } from "vue";
import { Button, ConfirmDialog, Icon, Row, RowGroup, RowNote, StatusBadge, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useOperation, useOperations } from "../../../../workbench/operations/operations";
import DeviceOpFailure from "./DeviceOpFailure.vue";
import RunnerProgress from "./RunnerProgress.vue";
import { type RunnerFailure, type RunnerOp, runnerFailure } from "./runnerFailure";
import { foldRunnerFlow, type RunnerFlow, settleRunnerFlow, startRunnerFlow } from "./runnerStages";
import { createRunner, removeRunner, syncRunnerSettings, updateRunner, useRunners } from "../../../../models/sandbox/devices/useRunners";
import { DeviceFlowLostError } from "../../../../models/sandbox/devices/useDevices";
import { lastRun, sentTo } from "./runnerWork";
import { beginDeviceWork } from "./deviceWork";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { useSandboxSettings } from "../../../../models/sandbox/useSandboxSettings";
import { type DeviceRow, type MachineRow, managerOf } from "../../../../models/sandbox/devices/deviceRows";
import { environmentTitle } from "../machineEnvironments";
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

const { runners, refetch, error: unread } = useRunners();

// The work this sandbox sends each runner (settings `offload`) and how its last offloaded run ended.
const { settings } = useSandboxSettings();
const { query: kindsQuery } = useSandboxQuery(rpcQuery(`offload.kinds`));
const { query: runsQuery } = useSandboxQuery(rpcQuery(`offload.runs`));
const sentHere = (runner: string): string[] => sentTo(runner, settings.value?.offload, kindsQuery.data.value?.kinds ?? []);
const lastHere = (runner: string): string | undefined => lastRun(runner, runsQuery.data.value?.runs ?? []);
const mine = computed(() => runners.value.filter((runner) => runner.host !== undefined && doors.value.has(runner.host)));

// Which side of a many-sided PC a runner was built through; silent on a machine with one door, where it would
// name the only thing it could.
const builtOn = (host: string | undefined): string | undefined => {
    const row = host === undefined ? undefined : doors.value.get(host);
    return machine.environments.length > 1 && row !== undefined ? environmentTitle(row) : undefined;
};

const working = (op: RunnerOp, name: string): string =>
    op === `create`
        ? t(`sandbox.deviceRunners.adding`, { name })
        : op === `remove`
          ? t(`sandbox.deviceRunners.removing`, { name })
          : t(`sandbox.deviceRunners.updating`, { name });

// One flow at a time on one machine, same rule the sandbox rows above follow. Building a container on somebody's
// laptop takes minutes, so the flow is the machine's rather than this view's: leaving the page and coming back finds
// its steps still moving, the buttons still held, and its end (the device's answer, or the notice and the line that
// does the same thing on the machine itself) waiting to be read. Each line is folded into the run's own entry as it
// arrives (runnerStages.ts), so the steps it draws on return are timed from when they really began. The machine's card
// on the board carries it while the reader is elsewhere, and a receipt says how it ended if nobody was here to see.
const flow = useOperation<string, RunnerFailure, RunnerFlow>(() => `devices/${machine.key}/runners`);
const busy = flow.busy;
const lines = flow.lines;
const done = flow.value;
const runnerRun = flow.progress;
// A settings push has no log, only an end; its failure is said where the flow's would be.
const syncs = useOperations<void, RunnerFailure>(() => `devices/${machine.key}/runner-sync`);
const syncing = (id: string): boolean => syncs.at(id)?.state === `running`;
const failure = computed(() => flow.failure.value ?? mine.value.map((runner) => syncs.at(runner.id)?.failure).find((found) => found !== undefined));
// An added runner has dialled in once the list shows it online, which is the last thing its card waits to say.
const paired = (name: string): boolean => mine.value.some((runner) => runner.id === name && runner.online);

const facts = (runner: { online: boolean; facts?: { cpus: number; memoryMb: number; load: number } }): string => {
    if (!runner.online) {
        return t(`sandbox.deviceRunners.offlineAsleep`);
    }
    return runner.facts === undefined
        ? t(`sandbox.deviceRunners.ready`)
        : t(`sandbox.deviceRunners.facts`, {
              cpus: runner.facts.cpus,
              memory: Math.round(runner.facts.memoryMb / 1024),
              load: runner.facts.load.toFixed(2),
          });
};

// Parity drift lines from the daemon: a "Setting …" line is fixable via Sync; others need a rebuild
// (remove and re-add).
const driftSummary = (runner: { drift?: { subject: string; detail: string }[] }): string | undefined => {
    if (runner.drift === undefined || runner.drift.length === 0) {
        return undefined;
    }
    return t(`sandbox.deviceRunners.differs`, { subjects: runner.drift.map((line) => line.subject).join(", ") });
};
const driftDetail = (runner: { drift?: { subject: string; detail: string }[] }): string =>
    (runner.drift ?? []).map((line) => `${line.subject} — ${line.detail}`).join("\n");
const syncable = (runner: { online: boolean; drift?: { subject: string }[] }): boolean =>
    runner.online && (runner.drift ?? []).some((line) => line.subject.startsWith(`Setting `));

const sync = async (id: string): Promise<void> => {
    if (syncs.busy.value) {
        return;
    }
    flow.dismiss();
    await syncs.run(id, {
        what: t(`sandbox.deviceRunners.syncing`),
        // No line of its own: a runner's settings are pushed over this door and have no CLI verb behind them.
        failed: (error) => ({ notice: noticeFrom(error, t(`sandbox.deviceRunners.settingsFailed`)) }),
        task: async () => {
            try {
                await syncRunnerSettings(id);
            } finally {
                refetch();
            }
        },
    });
};

// Asked for rather than generated, since it's what the placement picker shows: lowercase letters, digits and
// dashes, what `ic` accepts.
// Removal parks here until the app's own dialog answers, rather than the browser's confirm().
const confirmingRemove = ref<string | undefined>();
const removeHeader = computed(() => t(`sandbox.deviceRunners.removeHeader`, { name: confirmingRemove.value ?? `` }));

const run = async (op: RunnerOp, name: string): Promise<void> => {
    if (door.value?.device.hostId === undefined || busy.value) {
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
    if (host === undefined || busy.value) {
        return;
    }
    const label = machine.label;
    const key = machine.key;
    for (const runner of mine.value) {
        syncs.dismiss(runner.id);
    }
    const doing = working(op, name);
    await flow.run({
        what: t(`sandbox.deviceOps.doingOn`, { doing, machine: label }),
        tag: op,
        progress: startRunnerFlow(op, name, Date.now()),
        failed: (error, heard) => runnerFailure(op, name, label, error, heard),
        task: async (report) => {
            // The board's card for this machine turns too, as it does for every other thing done to it.
            const endMark = beginDeviceWork({ machine: key, doing, what: t(`sandbox.deviceOps.doingOn`, { doing, machine: label }) });
            const fold = (next: (previous: RunnerFlow) => RunnerFlow): void =>
                report.progress((previous) => next(previous ?? startRunnerFlow(op, name, Date.now())));
            const heard = (line: string): void => {
                report.line(line);
                fold((previous) => foldRunnerFlow(previous, line, Date.now()));
            };
            try {
                const said = await { create: createRunner, remove: removeRunner, update: updateRunner }[op](host, name, heard);
                fold((previous) => settleRunnerFlow(previous, `ok`, Date.now()));
                return said;
            } catch (error) {
                // A dropped stream is the machine carrying on with nobody listening, not a refusal.
                fold((previous) => settleRunnerFlow(previous, error instanceof DeviceFlowLostError ? `lost` : `failed`, Date.now()));
                throw error;
            } finally {
                endMark();
                // The list is the sandbox's, not this view's: it is read again whether or not anybody is here to see it.
                refetch();
            }
        },
    });
};

const asked = ref("");
const adding = ref(false);
const nameError = computed(() => (asked.value !== "" && !/^[a-z0-9-]+$/.test(asked.value) ? t(`sandbox.deviceRunners.nameRule`) : undefined));

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
    <RowGroup v-if="door" :label="t(`sandbox.deviceRunners.runners`)">
        <template #actions>
            <Button
                v-if="!adding"
                size="small"
                tier="boring"
                :label="t(`sandbox.deviceRunners.addRunner`)"
                :disabled="busy || door.device.online !== true"
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
                :class="ui.input({ size: `sm` }, `w-44`)"
                @keydown.enter.prevent="add()"
                @keydown.esc.prevent="adding = false"
            />
            <Button tier="accent" size="small" :label="t(`ui.action.create`)" :disabled="asked === `` || nameError !== undefined" @click="add()" />
            <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" @click="adding = false" />
            <span v-if="nameError" class="text-2xs text-danger">{{ nameError }}</span>
        </RowNote>

        <!-- A list that could not be read is said, not drawn as a machine with no runners. -->
        <RowNote v-if="unread !== undefined" variant="block">
            <span class="text-2xs text-danger">{{ t(`sandbox.deviceRunners.unread`, { reason: unread }) }}</span>
        </RowNote>

        <!-- One row each at the list's own height: what it is under its name, its state and its verbs at the edge, and only
             what needs a second look (what is sent here, the last run, drift) on a line of its own under the name. -->
        <Row
            v-for="runner in mine"
            :key="runner.id"
            :title="runner.id"
            :description="builtOn(runner.host) ? `${facts(runner)} · ${builtOn(runner.host)}` : facts(runner)"
            :data-runner="runner.id"
            indent
        >
            <template #lead="{ iconClass }">
                <Icon name="desktop" class="shrink-0" :class="[iconClass, runner.online ? 'text-accent' : 'text-subtle']" />
            </template>
            <template v-if="!runner.online || runner.parity === `outdated`" #meta>
                <StatusBadge v-if="!runner.online" variant="neutral" size="xs" :label="t(`sandbox.deviceRunners.offline`)" />
                <!-- A runner behind the parent runs fine until it doesn't, then fails as a link error rather than an old machine; drift is said here instead. -->
                <StatusBadge v-else variant="warning" size="xs" :label="t(`sandbox.deviceRunners.outdated`)" />
            </template>
            <!-- Update rebuilds an outdated container; Sync pushes the fixable half over the runner's live link. -->
            <template #control>
                <span class="flex items-center gap-1">
                    <Button
                        v-if="runner.parity === `outdated` && runner.online"
                        size="small"
                        tier="boring"
                        :label="t(`ui.action.update`)"
                        :disabled="busy || door.device.online !== true"
                        @click="run(`update`, runner.id)"
                    />
                    <Button
                        v-if="syncable(runner)"
                        size="small"
                        tier="quiet"
                        :label="syncing(runner.id) ? t(`sandbox.deviceRunners.syncing`) : t(`sandbox.deviceRunners.syncSettings`)"
                        :disabled="syncs.busy.value || busy"
                        @click="sync(runner.id)"
                    />
                    <Button
                        size="small"
                        tier="quiet"
                        tone="danger"
                        :label="t(`ui.action.remove`)"
                        :disabled="busy || door.device.online !== true"
                        @click="run(`remove`, runner.id)"
                    />
                </span>
            </template>
            <template v-if="sentHere(runner.id).length > 0 || lastHere(runner.id) || driftSummary(runner)" #below>
                <span class="flex min-w-0 flex-col text-2xs">
                    <!-- What this sandbox sends here, set under Agent → Tools → Where heavy work runs. -->
                    <span v-if="sentHere(runner.id).length > 0" class="truncate text-muted">{{
                        t(`sandbox.agentOffload.sentHere`, { kinds: sentHere(runner.id).join(`, `) })
                    }}</span>
                    <span v-if="lastHere(runner.id)" class="truncate text-subtle">{{ lastHere(runner.id) }}</span>
                    <!-- Detail rides the tooltip so the row stays one glance. -->
                    <span v-if="driftSummary(runner)" class="truncate text-warning" v-tooltip.top.lines="driftDetail(runner)">
                        {{ driftSummary(runner) }}
                    </span>
                </span>
            </template>
        </Row>

        <!-- Said where the list would be, since an empty surface with a heading reads as a failure to load. Not while the
             first one is being added: the card below already says what is on its way. -->
        <RowNote v-if="mine.length === 0 && !adding && runnerRun?.op !== `create`" variant="empty">{{
            t(`sandbox.deviceRunners.sandboxKeepsNoRunner`, { label: machine.label })
        }}</RowNote>

        <!-- A runner being added, updated or removed, drawn as the steps `ic` takes, the machine's output a press away and
             open by itself when the run stops. Kept once it ends, its verdict under the list until the reader puts it away. -->
        <RowNote v-if="runnerRun || failure" variant="block" class="flex flex-col gap-2">
            <RunnerProgress
                v-if="runnerRun"
                :flow="runnerRun"
                :live="busy"
                :lines="lines"
                :machine="machine.label"
                :outcome="done"
                :paired="paired(runnerRun.name)"
                :can-retry="!busy && door.device.online === true"
                @dismiss="flow.dismiss()"
                @retry="execute(runnerRun.op, runnerRun.name)"
            />
            <DeviceOpFailure v-if="failure" :of="failure.notice" :command="failure.command" :machine="machine.label" />
        </RowNote>

        <ConfirmDialog
            :open="confirmingRemove !== undefined"
            :header="removeHeader"
            :description="t(`sandbox.deviceRunners.runnerComesOffWork`, { label: machine.label })"
            :confirm-label="t(`ui.action.remove`)"
            confirm-icon="trash"
            @cancel="confirmingRemove = undefined"
            @confirm="removeConfirmed"
        />
    </RowGroup>
</template>
