<!-- ADD A SANDBOX WITHOUT LEAVING THE WORKSPACE: a name, where it runs, one press (useAddSandbox.ts says why it is not /setup).
     Mounted once by the shell, and only while asked for (models/sandbox/addSandbox.ts), so the registry watch and the
     offers it reads live no longer than it. Once the new sandbox reports in, the setup row selects it, which re-points
     the workspace there behind the dialog; the dialog stays up through its first start (AddSandboxOpening.vue) and
     closes onto a workspace ready to use. -->
<script setup lang="ts">
import { Button, Modal, Notice, SegmentedControl, ui, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { desktopVersion, openDesktopLink } from "../../../app/environments/desktop";
import { environment } from "../../../app/environments/environment";
import { scriptSource } from "../../../app/environments/scriptCommand";
import { useGoogleIdentity } from "../../../client/auth/useGoogleIdentity";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { apiClient } from "../../../lib/useApi";
import { markJustSetUp } from "../../../models/sandbox/live/justSetUp";
import { landOnAfterSwitch } from "../../../models/sandbox/sandboxScreen";
import { masterRail } from "../../../models/home/masterRail";
import DesktopSetupProgress from "../DesktopSetupProgress.vue";
import { useDesktopSetup } from "../desktopSetup";
import { platformUrlOf } from "../flow/installCommand";
import HostedWaitSteps from "../HostedWaitSteps.vue";
import SetupMachineProgress from "../SetupMachineProgress.vue";
import AddSandboxOpening from "./AddSandboxOpening.vue";
import { useAddSandbox } from "./useAddSandbox";

const emit = defineEmits<{ close: [] }>();

const t = useT();
const sandbox = useSandbox();
const { mobile } = useDevice();
const { getIdToken, warmIdToken } = useGoogleIdentity();
const platformUrl = platformUrlOf(environment.api.url);
// Set once the new sandbox reported in and was selected: the dialog then waits on its first start, not on its setup.
const opening = ref(false);

const add = useAddSandbox({
    sandbox,
    platform: apiClient.sandbox,
    inApp: () => desktopVersion() !== undefined,
    machines: () => true,
    buildsFromCheckout: platformUrl !== undefined && scriptSource.value === `checkout`,
    platformUrl,
    mobile,
    openDesktopLink,
    warmCredential: async () => {
        await warmIdToken();
        if ((await getIdToken({ interactive: false })) === undefined) {
            await getIdToken({ silent: true });
        }
    },
    enter: async () => {
        const id = add.created.value?.id;
        if (id === undefined) {
            return;
        }
        // The workspace's first quiet seconds are a connection on its way, not a setup left unfinished (justSetUp.ts).
        markJustSetUp(id);
        opening.value = true;
    },
});
const { name, problem, pick, options, loaded, creating, error, started, created, hostedWait, hostedRow, onMachine } = add;
onMounted(() => void add.read());
// Added from inside a sandbox, the new one opens on the full-screen chat, where its first session starts, rather than on
// the shell's default (the file tree with the chat docked). Recorded the moment the row exists: the switch lands on it
// once the row is selected. Added from Home (the first sandbox always is), it stays on Home, the new sandbox selected and
// its home conversation the chat on screen. A phone keeps its own landing, a conversation already.
watch(
    () => created.value?.id,
    (id) => {
        if (id !== undefined && !mobile.value && !masterRail.value) {
            landOnAfterSwitch(id, `/chat`);
        }
    },
);

const desktop = useDesktopSetup();
// The app's report, while it is about this sandbox: its module state may still hold an earlier install's last word.
const desktopReport = computed(() => {
    const report = desktop.report.value;
    return report !== undefined && (report.name === undefined || report.name === created.value?.name) ? report : undefined;
});

const machineFailed = computed(() => started.value?.kind === `machine` && onMachine.run.failure.value !== undefined);
const nothingOffered = computed(() => loaded.value && options.value.length === 0);
</script>

<template>
    <Modal
        :open="true"
        size="sm"
        :header="t(`setup.addSandbox.title`)"
        :description="started === undefined ? t(`setup.addSandbox.description`) : undefined"
        @update:open="(open: boolean) => open || emit(`close`)"
    >
        <!-- THE FORM: until the press has gone somewhere. -->
        <form v-if="started === undefined" class="flex flex-col gap-4" data-add-sandbox @submit.prevent="add.create">
            <label class="ui-field">
                <span class="ui-field-label">{{ t(`shared.name`) }}</span>
                <input v-model="name" autofocus :maxlength="80" :class="[ui.input(), problem ? `ui-field-error-box` : ``]" />
                <span v-if="problem" class="ui-field-error">
                    <Icon name="exclamation-triangle" class="text-2xs" />
                    {{ problem }}
                </span>
            </label>

            <div class="flex flex-col gap-1.5">
                <span class="ui-field-label">{{ t(`setup.setupOnMachine.runsOn`) }}</span>
                <p v-if="!loaded" class="flex items-center gap-2 text-xs text-muted">
                    <Icon name="spinner" spin class="text-xs" />
                    {{ t(`setup.addSandbox.lookingForMachines`) }}
                </p>
                <p v-else-if="nothingOffered" class="text-xs text-muted">{{ t(`setup.addSandbox.nothingInOnePress`) }}</p>
                <fieldset v-else :disabled="creating" class="min-w-0">
                    <!-- Drawn only with something on offer, so a pick always stands. -->
                    <SegmentedControl
                        :model-value="pick ?? ``"
                        :options="options"
                        :wrap="true"
                        :aria-label="t(`setup.setup.whereSandboxRuns`)"
                        @update:model-value="(value: string) => (pick = value)"
                    />
                </fieldset>
            </div>

            <Notice v-if="error" :of="error" />
            <!-- Enter in the name field submits. -->
            <button type="submit" class="hidden" tabindex="-1" aria-hidden="true"></button>
        </form>

        <!-- THE RUN: what the press started, drawn as /setup draws it. -->
        <div v-else class="flex flex-col gap-3" data-add-sandbox-run>
            <AddSandboxOpening v-if="opening && created" :sandbox-id="created.id" :name="created.name" @shown="emit(`close`)" />
            <template v-else-if="started.kind === `machine`">
                <SetupMachineProgress :door="started.door" :machine="onMachine" />
            </template>
            <template v-else-if="started.kind === `here`">
                <DesktopSetupProgress v-if="desktopReport" :report="desktopReport" :heard-at="desktop.heardAt.value" :step-since="desktop.stepSince.value" />
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
                </template>
                <HostedWaitSteps v-else-if="hostedRow !== null" :wait="hostedWait" />
                <p v-else class="flex items-center gap-2 text-xs text-muted">
                    <Icon name="spinner" spin class="text-xs" />
                    {{ t(`setup.setup.startingMachine`) }}
                </p>
            </template>
            <p v-if="!opening" class="text-2xs text-muted">{{ t(`setup.addSandbox.keepsGoing`, { name: created?.name ?? `` }) }}</p>
        </div>

        <template #footer>
            <div class="flex w-full flex-wrap items-center justify-end gap-2">
                <!-- Every other way (the command, the installer, an own domain) is /setup's, with its picker open. -->
                <RouterLink
                    v-if="started === undefined"
                    :to="{ path: `/setup`, query: { elsewhere: `1` } }"
                    class="mr-auto text-xs text-link hover:underline"
                    @click="emit(`close`)"
                    >{{ t(`setup.addSandbox.moreWays`) }}</RouterLink
                >
                <template v-if="started === undefined">
                    <Button :label="t(`ui.action.cancel`)" tier="quiet" @click="emit(`close`)" />
                    <Button
                        :label="t(`ui.action.create`)"
                        tier="accent"
                        :loading="creating"
                        :disabled="problem !== undefined || pick === undefined"
                        @click="add.create"
                    />
                </template>
                <template v-else>
                    <Button v-if="machineFailed" :label="t(`ui.action.tryAgain`)" tier="quiet" @click="add.retry" />
                    <Button :label="t(`ui.action.close`)" @click="emit(`close`)" />
                </template>
            </div>
        </template>
    </Modal>
</template>
