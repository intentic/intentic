<script setup lang="ts">
import { Button, Code, commandLang, ui, useOsPreference } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, ref } from "vue";
import { useRouter } from "vue-router";
import { apiClient } from "../../../lib/useApi";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { deviceRoute } from "../devices/deviceLinks";
import { useServingSlug } from "../environment/servingSlug";
import { devicesAcross, subscribeDevicesAcross } from "../live/devicesAcross";
import { expectRestart } from "../live/sandboxRestart";
import HostedRollbackDialog from "../overview/version/HostedRollbackDialog.vue";
import DiagnosisChain from "../diagnosis/DiagnosisChain.vue";
import FixCommand from "../diagnosis/FixCommand.vue";
import type { DiagnosisAction } from "../diagnosis/presentation";
import { recoveryCommands, type SiblingManager, siblingManagers } from "./recovery";
import { useDiagnosisNotice, useVisibleOutage } from "./useVisibleOutage";

// THE WAY BACK WHEN A SANDBOX DOESN'T COME BACK, drawn by the connecting gate and by the notification lane beneath the
// diagnosis's own sentence. It shows which link of the chain broke, what the machine the sandbox runs on found (in its
// own words), and ONE thing to do: the platform's restart or rollback for a machine we run, the one command (or the
// desktop app's button) for a machine of the owner's. Anything else waits behind "other options". Nothing here asks the
// daemon, which is the one thing not answering.

const t = useT();
const router = useRouter();

const { active, select } = useSandbox();
const slug = useServingSlug();
const notice = useDiagnosisNotice(useVisibleOutage());
const hosted = computed(() => (active.value?.hosted ?? null) !== null);
const owner = computed(() => active.value?.role === `owner`);
// The machine by the name it reported itself under, if it ever did.
const machine = computed(() => (hosted.value ? undefined : active.value?.hostReport?.machine));

// The owner's other sandboxes that can reach the same machine, read while this is on screen.
const release = hosted.value ? undefined : subscribeDevicesAcross();
onBeforeUnmount(() => release?.());
const siblings = computed(() => siblingManagers(devicesAcross.value, slug.value));
const manageFrom = (sibling: SiblingManager): void => {
    select(sibling.sandbox.id);
    void router.push(deviceRoute(sibling.machineKey));
};

const { cmdOs } = useOsPreference();
const commands = computed(() => recoveryCommands(slug.value, cmdOs.value));

const rollingBack = ref(false);
const restartFailed = ref(false);
// A restart the reader asked for is what the next silence is: armed before the ask, since the platform can take the
// machine down before the promise settles.
const restartHosted = async (): Promise<void> => {
    const sandbox = active.value?.id;
    if (sandbox === undefined) {
        return;
    }
    restartFailed.value = false;
    const settled = expectRestart({
        sandbox,
        id: `recovery`,
        what: t(`sandbox.diagnosis.restartingWhat`),
        quiet: { title: t(`sandbox.diagnosis.restartQuietTitle`), detail: t(`sandbox.diagnosis.restartQuietDetail`) },
        untilAnswered: true,
    });
    try {
        await apiClient.sandbox.hostedRestart({ sandboxId: sandbox });
    } catch {
        settled();
        restartFailed.value = true;
    }
};

const primary = computed(() => notice.value?.action);
const others = computed<readonly DiagnosisAction[]>(() => notice.value?.otherActions ?? []);
// Behind "other options": the other presses the diagnosis offers, and for a machine of the owner's the two
// single-purpose commands and any sibling that can press them there.
const hasOthers = computed(() => owner.value && (others.value.length > 0 || !hosted.value || siblings.value.length > 0));
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
                <Button size="small" :label="t(`sandbox.diagnosis.restartIt`)" @click="restartHosted">
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
                <template v-if="!hosted">
                    <Code :code="commands.restart" :lang="commandLang(cmdOs)" :label="t(`sandbox.sandboxRecovery.restartCommand`)" :wrap="true" />
                    <Code :code="commands.rollback" :lang="commandLang(cmdOs)" :label="t(`sandbox.sandboxRecovery.rollBackCommand`)" :wrap="true" />
                </template>
                <!-- The cheaper way where it exists: a sandbox of the owner's that still answers can press these on that machine. -->
                <p v-for="sibling in siblings" :key="sibling.sandbox.id" class="flex flex-wrap items-center gap-x-1.5 text-muted">
                    <span>{{ t(`sandbox.sandboxRecovery.siblingReaches`, { name: sibling.sandbox.name, machine: sibling.machineLabel }) }}</span>
                    <button type="button" :class="ui.textButton()" @click="manageFrom(sibling)">
                        {{ t(`sandbox.sandboxRecovery.openItsDevices`) }}
                    </button>
                </p>
            </div>
        </details>
        <HostedRollbackDialog :sandbox="rollingBack ? active : undefined" @close="rollingBack = false" />
    </div>
</template>
