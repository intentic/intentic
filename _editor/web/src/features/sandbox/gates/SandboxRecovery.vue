<script setup lang="ts">
import { Button, ConfirmDialog, DeviceRunLog, Notice, ui, useOsPreference } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { apiClient } from "../../../lib/useApi";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { desktopRepairLink, desktopVersion, openDesktopLink } from "../../../app/environments/desktop";
import { deviceRoute } from "../devices/deviceLinks";
import { useServingSlug } from "../environment/servingSlug";
import { manageDeviceSandbox } from "../devices/useDevices";
import { sandboxDoor } from "../live/sandboxDoors";
import { useDeviceRelays } from "../live/useDeviceRelays";
import { expectRestart } from "../live/sandboxRestart";
import { useOperation } from "../../../workbench/operations/operations";
import HostedRollbackDialog from "../overview/version/HostedRollbackDialog.vue";
import DiagnosisChain from "../diagnosis/DiagnosisChain.vue";
import FixCommand from "../diagnosis/FixCommand.vue";
import type { DiagnosisAction } from "../diagnosis/presentation";
import { recoveryCommands } from "./recovery";
import RunCommand from "../../../components/RunCommand.vue";
import { useDiagnosisNotice, useVisibleOutage } from "./useVisibleOutage";

// THE WAY BACK WHEN A SANDBOX DOESN'T COME BACK, drawn by the connecting gate and by the notification lane beneath the
// diagnosis's own sentence. It shows which link of the chain broke, what the machine the sandbox runs on found (in its
// own words), and ONE thing to do: the platform's restart or rollback for a machine we run, the one command (or the
// desktop app's button) for a machine of the owner's. Anything else waits behind "other options": there, a restart or a
// rollback is a press when another of the owner's sandboxes reaches that machine, and a command only when none does.
// Nothing here asks this sandbox's daemon, which is the one thing not answering.

const t = useT();
const router = useRouter();

const { active, sandboxes, select } = useSandbox();
const slug = useServingSlug();
const notice = useDiagnosisNotice(useVisibleOutage());
const hosted = computed(() => (active.value?.hosted ?? null) !== null);
const owner = computed(() => active.value?.role === `owner`);
// The machine by the name it reported itself under, if it ever did.
const machine = computed(() => (hosted.value ? undefined : active.value?.hostReport?.machine));

// THE OWNER'S OTHER SANDBOXES AS WAYS TO THIS ONE'S MACHINE, read fresh as this opens and kept read while it is on
// screen. This one is left out: it is the sandbox not answering, so it can carry nothing.
const { relays, looking, look } = useDeviceRelays({ withoutActive: true, follow: !hosted.value });
if (!hosted.value && owner.value) {
    void look();
}
const door = computed(() => (hosted.value ? undefined : sandboxDoor(relays.value, slug.value, active.value?.id)));
const relayName = computed(() => sandboxes.value.find((sandbox) => sandbox.id === door.value?.relay)?.name ?? ``);
const manageFrom = (): void => {
    const through = door.value;
    if (through !== undefined) {
        select(through.relay);
        void router.push(deviceRoute(through.machineKey));
    }
};

// A RESTART OR A ROLLBACK PRESSED ON THAT MACHINE through the sibling that reaches it: the same ops its Devices page
// runs, so the reader no longer has to go there, or type them. One at a time, kept in the ledger like the platform's.
type MachineOp = `restart` | `rollback`;
const onMachine = useOperation<string>(`gates/recovery/machine`);
const pressing = ref<MachineOp>();
const confirmingRollback = ref(false);
const pressOnMachine = async (op: MachineOp): Promise<void> => {
    confirmingRollback.value = false;
    const through = door.value;
    const sandbox = active.value?.id;
    const name = slug.value;
    if (through === undefined || sandbox === undefined || name === undefined || onMachine.busy.value) {
        return;
    }
    pressing.value = op;
    const label = through.machineLabel;
    const what = op === `restart` ? t(`sandbox.sandboxRecovery.restartingOn`, { machine: label }) : t(`sandbox.sandboxRecovery.rollingBackOn`, { machine: label });
    await onMachine.run({
        what,
        failed: t(`sandbox.sandboxRecovery.couldntOn`, { machine: label }),
        task: async (report) => {
            // What the coming silence and return are, for every surface; its end is this sandbox answering again.
            const settled = expectRestart({ sandbox, id: `recovery`, what, quiet: { title: what, detail: t(`sandbox.sandboxRecovery.picksUpByItself`) }, untilAnswered: true });
            try {
                return await manageDeviceSandbox(through.hostId, name, op, { at: through.relay, onLine: report.line });
            } catch (error) {
                settled();
                throw error;
            }
        },
    });
};

const { cmdOs } = useOsPreference();
const commands = computed(() => recoveryCommands(slug.value, cmdOs.value));

const rollingBack = ref(false);
// The ask is the sandbox's, in the operations ledger: the gate and the notification lane both draw this, and either
// one opened while the platform is still answering holds the button rather than asking twice.
const restart = useOperation(`gates/recovery/restart`);
const restartFailed = computed(() => restart.failure.value !== undefined);
// A restart the reader asked for is what the next silence is: armed before the ask, since the platform can take the
// machine down before the promise settles.
const restartHosted = async (): Promise<void> => {
    const sandbox = active.value?.id;
    if (sandbox === undefined || restart.busy.value) {
        return;
    }
    await restart.run({
        what: t(`sandbox.diagnosis.restartingWhat`),
        failed: t(`sandbox.diagnosis.restartFailed`),
        // Its end is the sandbox answering again, which says so by itself.
        quiet: true,
        task: async () => {
            const settled = expectRestart({
                sandbox,
                id: `recovery`,
                what: t(`sandbox.diagnosis.restartingWhat`),
                quiet: { title: t(`sandbox.diagnosis.restartQuietTitle`), detail: t(`sandbox.diagnosis.restartQuietDetail`) },
                untilAnswered: true,
            });
            try {
                await apiClient.sandbox.hostedRestart({ sandboxId: sandbox });
            } catch (error) {
                settled();
                throw error;
            }
        },
    });
};

const primary = computed(() => notice.value?.action);
const others = computed<readonly DiagnosisAction[]>(() => notice.value?.otherActions ?? []);
// Behind "other options": the other presses the diagnosis offers, and for a machine of the owner's the restart and the
// rollback, as presses where a sibling reaches that machine and as commands where none does.
const hasOthers = computed(() => owner.value && (others.value.length > 0 || !hosted.value));
const desktop = desktopVersion() !== undefined;
const repairReason = computed(() => notice.value?.findings.map((check) => check.problem ?? check.label).join(`; `) || undefined);
const askRepair = (): void => {
    openDesktopLink(
        desktopRepairLink({
            slug: slug.value,
            from: `recovery`,
            reason: repairReason.value,
        }),
    );
};
</script>

<template>
    <div v-if="notice !== undefined" class="flex min-w-0 flex-col gap-3 text-left">
        <DiagnosisChain v-if="notice.chain.length > 0" :links="notice.chain" />
        <ul v-if="notice.findings.length > 0" class="flex min-w-0 flex-col gap-2">
            <li v-for="check in notice.findings" :key="check.id" class="flex min-w-0 flex-col gap-0.5 text-xs">
                <span class="flex items-center gap-1.5 font-medium text-content">
                    <Icon v-if="check.state === `fixing`" name="spinner" spin class="size-3 shrink-0 text-info" />
                    <span v-else class="size-2 shrink-0 rounded-full" :class="check.state === `fail` ? `bg-danger` : `bg-warning`" />
                    {{ check.label }}
                </span>
                <span v-if="check.problem" class="text-muted">{{ check.problem }}</span>
                <span v-if="check.remedy" class="text-muted">{{ check.remedy }}</span>
            </li>
        </ul>
        <div v-if="primary === `restart-hosted`" class="flex flex-col gap-1">
            <div>
                <Button size="small" :label="t(`sandbox.diagnosis.restartIt`)" :loading="restart.busy.value" @click="restartHosted">
                    <template #icon><Icon name="refresh" /></template>
                </Button>
            </div>
            <p v-if="restartFailed" class="text-xs text-danger">{{ t(`sandbox.diagnosis.restartFailed`) }}</p>
        </div>
        <div v-else-if="primary === `rollback-hosted`">
            <Button size="small" :label="t(`capabilities.hostRecreate.rollBackVerb`)" @click="rollingBack = true">
                <template #icon><Icon name="undo" /></template>
            </Button>
        </div>
        <FixCommand v-else-if="primary === `fix`" :machine="machine" />
        <div v-if="desktop && !hosted && owner" class="flex flex-wrap items-center gap-2">
            <Button size="small" :label="t(`local.repair.title`)" @click="askRepair">
                <template #icon><Icon name="wrench" /></template>
            </Button>
            <span class="text-xs text-subtle">{{ t(`local.repair.subtitle`) }}</span>
        </div>
        <details v-if="hasOthers" class="min-w-0 text-xs">
            <summary class="cursor-pointer text-link">{{ t(`sandbox.diagnosis.otherOptions`) }}</summary>
            <div class="mt-2 flex min-w-0 flex-col gap-3">
                <div v-if="others.includes(`restart-hosted`) || others.includes(`rollback-hosted`)" class="flex flex-wrap gap-2">
                    <Button v-if="others.includes(`restart-hosted`)" size="small" tier="boring" :label="t(`sandbox.diagnosis.restartIt`)" @click="restartHosted" />
                    <Button
                        v-if="others.includes(`rollback-hosted`)"
                        size="small"
                        tier="boring"
                        :label="t(`capabilities.hostRecreate.rollBackVerb`)"
                        @click="rollingBack = true"
                    />
                </div>
                <FixCommand v-if="others.includes(`fix`)" :machine="machine" />
                <!-- A sandbox of the owner's that still answers reaches the machine: the two presses, made there now. -->
                <div v-if="door" class="flex min-w-0 flex-col gap-2">
                    <div class="flex flex-wrap gap-2">
                        <Button
                            size="small"
                            tier="boring"
                            :label="t(`sandbox.sandboxRecovery.restartOn`, { machine: door.machineLabel })"
                            :loading="onMachine.busy.value && pressing === `restart`"
                            :disabled="onMachine.busy.value"
                            @click="pressOnMachine(`restart`)"
                        >
                            <template #icon><Icon name="refresh" /></template>
                        </Button>
                        <Button
                            size="small"
                            tier="boring"
                            :label="t(`sandbox.sandboxRecovery.rollBackOn`, { machine: door.machineLabel })"
                            :loading="onMachine.busy.value && pressing === `rollback`"
                            :disabled="onMachine.busy.value"
                            @click="confirmingRollback = true"
                        >
                            <template #icon><Icon name="undo" /></template>
                        </Button>
                    </div>
                    <p class="flex flex-wrap items-center gap-x-1.5 text-muted">
                        <span>{{ t(`sandbox.sandboxRecovery.throughSibling`, { name: relayName, machine: door.machineLabel }) }}</span>
                        <button type="button" :class="ui.textButton()" @click="manageFrom">{{ t(`sandbox.sandboxRecovery.openItsDevices`) }}</button>
                    </p>
                    <DeviceRunLog
                        v-if="onMachine.busy.value || onMachine.lines.value.length > 0"
                        :lines="onMachine.lines.value"
                        :running="onMachine.busy.value"
                        :empty="t(`sandbox.sandboxRecovery.startingOn`, { machine: door.machineLabel })"
                    />
                    <Notice v-if="onMachine.failure.value" :of="onMachine.failure.value" />
                    <p v-else-if="onMachine.value.value" class="text-muted">{{ onMachine.value.value }}</p>
                </div>
                <!-- Not found YET: the siblings are being asked, and a command drawn now is often replaced a second later. -->
                <p v-else-if="!hosted && looking" class="flex items-center gap-2 text-muted">
                    <Icon name="spinner" spin class="shrink-0" />{{ t(`sandbox.sandboxRecovery.lookingForMachine`) }}
                </p>
                <template v-else-if="!hosted">
                    <!-- One shell choice for both: the first carries the toggle, the second follows it. -->
                    <RunCommand :command="(os) => recoveryCommands(slug, os).restart" :label="t(`sandbox.sandboxRecovery.restartCommand`)" />
                    <RunCommand :command="commands.rollback" :os="cmdOs" :label="t(`sandbox.sandboxRecovery.rollBackCommand`)" />
                </template>
            </div>
        </details>
        <HostedRollbackDialog :sandbox="rollingBack ? active : undefined" @close="rollingBack = false" />
        <ConfirmDialog
            :open="confirmingRollback && door !== undefined"
            :header="t(`sandbox.sandboxRecovery.rollBackOnHeader`, { machine: door?.machineLabel ?? `` })"
            :description="t(`sandbox.sandboxRecovery.rollBackOnBody`)"
            :confirm-label="t(`capabilities.hostRecreate.rollBackVerb`)"
            confirm-icon="undo"
            @cancel="confirmingRollback = false"
            @confirm="pressOnMachine(`rollback`)"
        />
    </div>
</template>
