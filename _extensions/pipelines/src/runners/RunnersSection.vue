<script setup lang="ts">
import type { CiRepo } from "@intentic/sandbox-contract/schemas/ci";
import { Button, ConfirmDialog, Icon, RowGroup, RowNote, useNow } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { t } from "../i18n.js";
import AddRunnerDialog from "./AddRunnerDialog.vue";
import FleetPasses from "./FleetPasses.vue";
import RunnerLogsDialog from "./RunnerLogsDialog.vue";
import RunnerRow from "./RunnerRow.vue";
import type { CiRunner, CiRunnerOp } from "./fleetTypes";
import { type FleetDevice, type FleetRead, passViews, poolLine, serviceLine } from "./runnerFleet";
import { addKey, useRunnerFleet } from "./useRunnerFleet";

// THE RUNNERS SECTION: the self-hosted GitHub Actions runners on the owner's connected computers, one group per
// computer, under the board's runs. Absent altogether when no computer has runners or a fleet service to add one, and
// for a reader below maintainer, whom the routes refuse.

defineProps<{ repos: readonly CiRepo[] }>();

const { reads, busy, notes, op, remove, register, logs } = useRunnerFleet();
// A runner's "for 5m" moves on its own between reads; a minute is as fine as the words go.
const now = useNow(computed(() => reads.value.length > 0), 30_000);

const pendingFor = (device: FleetDevice, runner: CiRunner): ReadonlySet<string> => {
    const prefix = `${device.id}\n${runner.name}\n`;
    return new Set([...busy.value].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)));
};

const SERVICE_INK = { success: `text-success`, warning: `text-warning`, neutral: `text-subtle` } as const;

// One dialog of each kind for the whole section, aimed at the runner or computer it was opened for.
const logsOf = ref<{ device: FleetDevice; name: string } | undefined>();
const logsOpen = computed({
    get: () => logsOf.value !== undefined,
    set: (value: boolean) => {
        if (!value) {
            logsOf.value = undefined;
        }
    },
});
const removing = ref<{ device: FleetDevice; name: string } | undefined>();
const adding = ref<FleetRead | undefined>();
const addOpen = computed({
    get: () => adding.value !== undefined,
    set: (value: boolean) => {
        if (!value) {
            adding.value = undefined;
        }
    },
});

const readLogs = (): Promise<string> => (logsOf.value === undefined ? Promise.resolve(``) : logs(logsOf.value.device, logsOf.value.name));
const onAdd = (input: { repo: string; name: string; labels: string[] }): void => {
    if (adding.value !== undefined) {
        void register(adding.value.device, input);
    }
};
const onOp = (device: FleetDevice, name: string, which: CiRunnerOp): void => {
    void op(device, name, which);
};
const confirmRemove = (): void => {
    const target = removing.value;
    removing.value = undefined;
    if (target !== undefined) {
        void remove(target.device, target.name);
    }
};
</script>

<template>
    <div v-if="reads.length > 0" class="flex flex-col gap-6">
        <RowGroup v-for="read in reads" :key="read.device.id" :label="t(`runners.title`, { device: read.device.label })">
            <template v-if="read.fleet" #info>
                <span class="truncate text-2xs" :class="SERVICE_INK[serviceLine(read.fleet.service).tone]">{{ serviceLine(read.fleet.service).text }}</span>
            </template>
            <template v-if="read.fleet?.service.running" #actions>
                <Button
                    size="small"
                    tier="boring"
                    :label="t(`runners.action.add`)"
                    :loading="busy.has(addKey(read.device))"
                    @click="adding = read"
                >
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </template>

            <RowNote v-if="read.error" icon="exclamation-circle" tone="danger" class="break-words">
                {{ t(`runners.notAnswering`, { error: read.error }) }}
            </RowNote>
            <template v-if="read.fleet">
                <RowNote v-if="serviceLine(read.fleet.service).problem" icon="exclamation-circle" tone="warning" class="break-words">
                    {{ serviceLine(read.fleet.service).problem }}
                </RowNote>
                <RowNote v-if="read.fleet.slots">{{ poolLine(read.fleet.slots) }}</RowNote>
                <RowNote
                    v-if="notes[read.device.id]?.text"
                    :icon="notes[read.device.id]?.tone === `danger` ? `exclamation-circle` : `info-circle`"
                    :tone="notes[read.device.id]?.tone === `danger` ? `danger` : `default`"
                    class="break-words"
                >
                    {{ notes[read.device.id]?.text }}
                </RowNote>
                <RunnerRow
                    v-for="runner in read.fleet.runners"
                    :key="runner.name"
                    :runner="runner"
                    :service="read.fleet.service"
                    :pending="pendingFor(read.device, runner)"
                    :now="now"
                    @op="onOp(read.device, runner.name, $event)"
                    @logs="logsOf = { device: read.device, name: runner.name }"
                    @remove="removing = { device: read.device, name: runner.name }"
                />
                <FleetPasses :passes="passViews(read.fleet, now)" />
            </template>
        </RowGroup>

        <RunnerLogsDialog v-if="logsOf" v-model:open="logsOpen" :name="logsOf.name" :read="readLogs" />
        <AddRunnerDialog
            v-if="adding?.fleet"
            v-model:open="addOpen"
            :device="adding.device"
            :runners="adding.fleet.runners"
            :repos="repos"
            @submit="onAdd"
        />
        <ConfirmDialog
            :open="removing !== undefined"
            :header="t(`runners.remove.header`, { name: removing?.name ?? `` })"
            :description="t(`runners.remove.description`, { device: removing?.device.label ?? `` })"
            :confirm-label="t(`runners.remove.confirm`)"
            confirm-icon="trash"
            destructive
            @cancel="removing = undefined"
            @confirm="confirmRemove"
        />
    </div>
</template>
