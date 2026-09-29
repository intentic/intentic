<script setup lang="ts">
import { Button, Code, commandLang, osOptions, SegmentedControl, ui, useDevice, useOsPreference } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, ref } from "vue";
import { useRouter } from "vue-router";
import { DESKTOP_LAUNCHER_LINK, desktopRecreateLink, desktopVersion, openDesktopLink } from "../../../app/environments/desktop";
import { useSandbox } from "../client/useSandbox";
import { deviceRoute } from "../devices/deviceLinks";
import { useServingSlug } from "../environment/servingSlug";
import { devicesAcross, subscribeDevicesAcross } from "../live/devicesAcross";
import { phoneBrowser } from "../secrets/endpoint";
import HostedRollbackDialog from "../overview/version/HostedRollbackDialog.vue";
import { recoveryCommands, type SiblingManager, siblingManagers } from "./recovery";

// THE WAY BACK WHEN A SANDBOX DOESN'T COME BACK, drawn by the connecting gate and by the notification lane once the
// silence has outlasted its patience (useRecovery.ts). Nothing here asks the daemon, which is the one thing that is
// not answering: the name comes from the cached container name or the platform's row (servingSlug.ts), the commands are
// for the machine itself, the app's links are answered by the app on that machine, and a sibling is asked about its own
// devices. A hosted sandbox has no machine of the owner's to type on: its way back is the platform's rollback.

const t = useT();
const router = useRouter();

const { active, select } = useSandbox();
const slug = useServingSlug();
const hosted = computed(() => (active.value?.hosted ?? null) !== null);

// The OS the commands are spelled for; the shared preference, so this reads the way every other command block does.
const { cmdOs } = useOsPreference();
const commands = computed(() => recoveryCommands(slug.value, cmdOs.value));
// The app's links only work from its own window (it refuses them from anywhere else), and they run on this computer.
const desktop = desktopVersion() !== undefined;
// A phone can run none of it: say where it has to happen, and fold the commands away for whoever will type them there.
const { mobile } = useDevice();
const remote = computed(() => mobile.value || phoneBrowser(navigator.userAgent));

// The owner's other sandboxes that can reach the same machine, read while this is on screen.
const release = hosted.value ? undefined : subscribeDevicesAcross();
onBeforeUnmount(() => release?.());
const siblings = computed(() => siblingManagers(devicesAcross.value, slug.value));
const manageFrom = (sibling: SiblingManager): void => {
    select(sibling.sandbox.id);
    void router.push(deviceRoute(sibling.machineKey));
};

const rollingBackHosted = ref(false);
</script>

<template>
    <div class="flex min-w-0 flex-col gap-3 text-left">
        <template v-if="hosted">
            <p class="text-xs text-muted">{{ t(`sandbox.sandboxRecovery.hostedLead`) }}</p>
            <div>
                <Button size="small" :label="t(`capabilities.hostRecreate.rollBackVerb`)" @click="rollingBackHosted = true">
                    <template #icon><Icon name="undo" /></template>
                </Button>
            </div>
            <HostedRollbackDialog :sandbox="rollingBackHosted ? active : undefined" @close="rollingBackHosted = false" />
        </template>
        <template v-else>
            <p class="text-xs text-muted">{{ remote ? t(`sandbox.sandboxRecovery.remoteLead`) : t(`sandbox.sandboxRecovery.lead`) }}</p>
            <!-- The same two acts as the first two commands, as presses, for a reader already in the app on that machine. -->
            <div v-if="desktop && slug" class="flex flex-wrap items-center gap-2">
                <Button size="small" :label="t(`capabilities.hostRecreate.rollBackVerb`)" @click="openDesktopLink(desktopRecreateLink(slug, undefined, true))">
                    <template #icon><Icon name="undo" /></template>
                </Button>
                <Button size="small" severity="secondary" :label="t(`sandbox.sandboxRecovery.restartInApp`)" @click="openDesktopLink(DESKTOP_LAUNCHER_LINK)" />
            </div>
            <component :is="remote ? `details` : `div`" class="min-w-0">
                <summary v-if="remote" class="cursor-pointer text-xs text-link">{{ t(`sandbox.sandboxRecovery.showCommands`) }}</summary>
                <div class="flex min-w-0 flex-col gap-3" :class="{ 'mt-3': remote }">
                    <SegmentedControl v-model="cmdOs" size="sm" class="self-start" :options="osOptions()" />
                    <Code :code="commands.rollback" :lang="commandLang(cmdOs)" :label="t(`sandbox.sandboxRecovery.rollBackCommand`)" :wrap="true" />
                    <Code :code="commands.restart" :lang="commandLang(cmdOs)" :label="t(`sandbox.sandboxRecovery.restartCommand`)" :wrap="true" />
                    <Code :code="commands.doctor" :lang="commandLang(cmdOs)" :label="t(`sandbox.sandboxRecovery.doctorCommand`)" :wrap="true" />
                </div>
            </component>
            <!-- The cheaper way where it exists: a sandbox of the owner's that still answers can press these on that machine. -->
            <p v-for="sibling in siblings" :key="sibling.sandbox.id" class="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                <span>{{ t(`sandbox.sandboxRecovery.siblingReaches`, { name: sibling.sandbox.name, machine: sibling.machineLabel }) }}</span>
                <button type="button" :class="ui.linkButton()" @click="manageFrom(sibling)">
                    {{ t(`sandbox.sandboxRecovery.openItsDevices`) }}
                </button>
            </p>
        </template>
    </div>
</template>
