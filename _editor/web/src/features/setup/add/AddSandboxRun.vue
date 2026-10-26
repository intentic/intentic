<!-- WHAT AN ADD SANDBOX PRESS STARTED: the app's install on this computer, the run on a connected machine, the wait on a
     machine of ours, the command to run on a server, then the new sandbox's first start (AddSandboxOpening.vue), which
     is all an address already answering has left. Drawn by the dialog and by Home's new sandbox in place; each says for
     itself what closing it means. -->
<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import DesktopSetupProgress from "../DesktopSetupProgress.vue";
import { tellSlowDownloadHosted } from "../desktopSetup";
import HostedWaitSteps from "../HostedWaitSteps.vue";
import SetupMachineProgress from "../SetupMachineProgress.vue";
import AddSandboxCommand from "./AddSandboxCommand.vue";
import AddSandboxOpening from "./AddSandboxOpening.vue";
import type { AddSandboxHere } from "./useAddSandboxHere";

// `opening`: the row reported in and was selected, so what is left is its first start. `inPlace`: drawn on Home's page,
// which says for itself that leaving it does not stop the run.
const { here, opening, inPlace = false } = defineProps<{ here: AddSandboxHere; opening: boolean; inPlace?: boolean }>();
const emit = defineEmits<{ shown: [] }>();

const t = useT();
const { started, created, hostedWait, hostedRow, hostedBusy, hostedInstead, onMachine } = here.add;
const { desktop, desktopReport } = here;
// The slow download's offer taken: said for the funnel (desktopSetup.ts) before the run moves to a machine of ours.
const takeHostedForSlowDownload = (): void => {
    tellSlowDownloadHosted(desktopReport.value);
    void here.add.toHosted();
};
</script>

<template>
    <div v-if="started" class="flex flex-col gap-3" data-add-sandbox-run>
        <AddSandboxOpening v-if="opening && created" :sandbox-id="created.id" :name="created.name" @shown="emit(`shown`)" />
        <template v-else-if="started.kind === `machine`">
            <SetupMachineProgress :door="started.door" :machine="onMachine" />
        </template>
        <AddSandboxCommand v-else-if="started.kind === `command`" :add="here.add" />
        <!-- An address already answering was recorded: it opens on its first start, above, the moment it is selected. -->
        <p v-else-if="started.kind === `attach`" class="flex items-center gap-2 text-xs text-muted">
            <Icon name="spinner" spin class="text-xs" />
            {{ t(`setup.addSandbox.connected`) }}
        </p>
        <template v-else-if="started.kind === `here`">
            <DesktopSetupProgress
                v-if="desktopReport"
                :report="desktopReport"
                :heard-at="desktop.heardAt.value"
                :step-since="desktop.stepSince.value"
                :sandbox-id="created?.id"
                :hosted-offered="hostedInstead"
                :in-place="inPlace"
                @hosted="takeHostedForSlowDownload"
                @elsewhere="here.add.toHosted"
            />
            <p v-else class="flex items-center gap-2 text-xs text-muted">
                <Icon name="spinner" spin class="text-xs" />
                {{ t(`setup.setup.appSettingUp`) }}
            </p>
        </template>
        <template v-else>
            <template v-if="hostedRow !== null && hostedWait.failure">
                <p class="flex items-start gap-2 text-xs text-content">
                    <Icon name="exclamation-circle" class="shrink-0 text-warning" />
                    <span>{{ hostedWait.failure.problem }}</span>
                </p>
                <p class="text-xs text-muted">{{ hostedWait.failure.remedy }}</p>
                <!-- Starting it over only where it can work: after a refused start, another is the one press that cannot help. -->
                <Button
                    v-if="hostedWait.failure.action !== `none`"
                    :label="t(`setup.setup.startOver`)"
                    size="small"
                    class="self-start"
                    :disabled="hostedBusy"
                    @click="here.add.restartHosted"
                >
                    <template #icon><Icon name="refresh" /></template>
                </Button>
            </template>
            <HostedWaitSteps v-else-if="hostedRow !== null" :wait="hostedWait" />
            <p v-else class="flex items-center gap-2 text-xs text-muted">
                <Icon name="spinner" spin class="text-xs" />
                {{ t(`setup.setup.startingMachine`) }}
            </p>
        </template>
    </div>
</template>
