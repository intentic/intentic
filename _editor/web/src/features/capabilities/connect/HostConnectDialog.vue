<script setup lang="ts">
import { type HostSummary, userDistrosOf } from "@intentic/sandbox-contract";
import { Button, Code, Modal, type NoticeModel, Notice, SegmentedControl, noticeFrom } from "@intentic/ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useDevices } from "../../sandbox/devices/useDevices";
import { HOST_DOOR, usePeerConnect } from "../../sandbox/devices/usePeerConnect";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { bashCommand, psCommand } from "../../../app/environments/scriptCommand";
import { cleanName } from "../model/form";
import ScriptSourceSwitch from "./ScriptSourceSwitch.vue";
import { useCapabilities } from "./useCapabilities";
import { useT } from "@intentic/ui/i18n";

// Connect-this-device dialog for a host-kind capability: a tab can't install anything on another machine, so this
// hands over a command instead. States the command and the exact permissions the machine will enforce. Flips to a
// live confirmation once the machine connects, no refresh needed. A Linux device that is a WSL distro of a Windows
// PC already connected can take its command from PowerShell, where a reader on that PC is sitting.
//
// A machine still wearing its tile's name (`unnamed`) is offered its own hostname the moment it connects: the id is
// the agent's handle (tool prefix, skill file), a hostname is what the owner would have typed, and nothing has used
// the name yet, so the rename is a migration with nothing to migrate.

const t = useT();

const props = defineProps<{ visible: boolean; id: string; platform: string; permissions: string; unnamed?: boolean }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "connected"): void; (event: "renamed", to: string): void }>();

const { peerFor, pairToken, minting, error, connect, start, stop, close } = usePeerConnect<HostSummary>(HOST_DOOR);
const { daemonUrl } = useSandbox();

// The distros every connected Windows PC lists, read off the fleet already held (no poll): the Linux one-liner can
// be run inside one from PowerShell, so a reader on that PC never has to open the distro's own terminal first.
const { devices } = useDevices({ poll: false });
const distros = computed(() => (props.platform === `linux` ? [...new Set(devices.value.flatMap((device) => userDistrosOf(device.facts)))] : []));
type Via = `terminal` | `powershell`;
const VIA_OPTIONS = computed((): { label: string; value: Via; title: string }[] => [
    {
        label: t(`capabilities.hostConnectDialog.terminalInDistro`),
        value: `terminal`,
        title: t(`capabilities.hostConnectDialog.runInsideLinuxEnvironment`),
    },
    { label: t(`capabilities.hostConnectDialog.powershell`), value: `powershell`, title: t(`capabilities.hostConnectDialog.runWindowsInsideDistro`) },
]);
const via = ref<Via>(`terminal`);
const distro = ref(``);
// A device named for a distro (`<pc>-wsl-<distro>`, the name the machine page connects it under) opens on the
// PowerShell form for that distro; any other Linux device opens on its own terminal.
watch(
    [() => props.visible, distros],
    ([visible, listed]) => {
        if (!visible) {
            return;
        }
        const named = listed.find((candidate) => props.id.toLowerCase().endsWith(`-wsl-${candidate.toLowerCase()}`));
        via.value = named === undefined ? `terminal` : `powershell`;
        distro.value = named ?? listed[0] ?? ``;
    },
    { immediate: true },
);
const distroOptions = computed(() =>
    distros.value.map((name) => ({ label: name, value: name, title: t(`capabilities.hostConnectDialog.runInside`, { name }) })),
);

const host = computed(() => peerFor(props.id));
const online = computed(() => host.value?.online === true);

// What the machine calls itself, in the shape the Devices board folds two doors of one PC on: `<hostname>` for a
// native install, `<hostname>-wsl-<distro>` for a distro. Absent until the machine has said, or when it says the name
// it already has.
const hostnameSuggestion = computed<string | undefined>(() => {
    const facts = host.value?.facts;
    if (props.unnamed !== true || facts?.hostname === undefined) {
        return undefined;
    }
    const suggested = cleanName(facts.wsl === undefined ? facts.hostname : `${facts.hostname}-wsl-${facts.wsl.distro}`).toLowerCase();
    return suggested === `` || suggested === props.id.toLowerCase() ? undefined : suggested;
});
// The name taken, held here so the panel stays on "named" while the machine drops and re-dials under it.
const renamedTo = ref<string>();
const renaming = ref(false);
const renameError = ref<NoticeModel>();
const takeHostname = async (): Promise<void> => {
    const to = hostnameSuggestion.value;
    if (to === undefined || renaming.value) {
        return;
    }
    renaming.value = true;
    renameError.value = undefined;
    try {
        await useCapabilities().rename.mutateAsync({ id: props.id, to });
    } catch (caught) {
        renameError.value = noticeFrom(caught, t(`capabilities.hostConnectDialog.couldNotRename`));
        return;
    } finally {
        renaming.value = false;
    }
    renamedTo.value = to;
    emit(`renamed`, to);
};
// The Linux one-liner as PowerShell hands it to a distro: one double-quoted argument for `sh -c`, which wsl.exe
// passes through verbatim under `--exec`. The line carries no `$` or backtick, so PowerShell leaves it alone.
const fromPowerShell = computed(() => props.platform === `linux` && via.value === `powershell` && distro.value !== ``);
const command = computed(() => {
    const url = daemonUrl.value ?? ``;
    if (url === `` || pairToken.value === undefined) {
        return ``;
    }
    if (props.platform === `windows`) {
        return psCommand(`devicePs1`, `$env:SANDBOX_URL='${url}'; $env:PAIR_TOKEN='${pairToken.value}'; `);
    }
    const bash = bashCommand(`deviceSh`, `env SANDBOX_URL='${url}' PAIR_TOKEN='${pairToken.value}' `, ``);
    return fromPowerShell.value ? `wsl -d ${distro.value} --exec sh -c "${bash}"` : bash;
});
const shell = computed(() => (props.platform === `windows` || fromPowerShell.value ? `PowerShell` : `a terminal`));

// Opening mints; closing forgets. A pairing left live in a closed tab is a credential nobody is watching.
watch(
    () => props.visible,
    async (visible) => {
        if (!visible) {
            close();
            stop();
            return;
        }
        renamedTo.value = undefined;
        renameError.value = undefined;
        start();
        await connect(props.id);
    },
);

// The moment the machine reports in, tell the page so the capability's status refreshes behind the dialog.
watch(online, (isOnline) => {
    if (isOnline) {
        emit(`connected`);
    }
});

onBeforeUnmount(stop);
</script>

<template>
    <Modal :open="visible" size="lg" :header="t(`shared.connect`, { id })" @update:open="emit(`update:visible`, $event)">
        <div class="flex flex-col gap-4">
            <p class="text-sm text-content">
                {{ t(`capabilities.hostConnectDialog.runOn`) }} <b>{{ id }}</b
                >{{ t(`capabilities.hostConnectDialog.in`) }} {{ shell }}{{ t(`capabilities.hostConnectDialog.yourselfInstallsSmallAgent`) }}
            </p>

            <!-- Renamed stays up through the reconnect it causes: the old id goes offline for a moment, which is not a failed pairing. -->
            <div v-if="renamedTo !== undefined" class="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-content">
                {{ t(`capabilities.hostConnectDialog.named`) }} <b>{{ renamedTo }}</b
                >{{ t(`capabilities.hostConnectDialog.reconnectsUnderThatName`) }}
            </div>

            <template v-else-if="online">
                <div class="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-content">
                    <b>{{ id }}</b> {{ t(`capabilities.hostConnectDialog.connectedAgentWorkOn`) }}
                </div>
                <!-- Offered, not applied: the name is what the agent calls the machine, so the owner says which. -->
                <div v-if="hostnameSuggestion !== undefined" class="flex flex-col gap-2 rounded-md border border-subtle px-3 py-2">
                    <Notice v-if="renameError" :of="renameError" />
                    <p class="text-sm text-content">
                        {{ t(`capabilities.hostConnectDialog.callsItself`) }} <b class="font-mono">{{ hostnameSuggestion }}</b
                        >{{ t(`capabilities.hostConnectDialog.nameItThatToo`) }}
                    </p>
                    <div class="flex flex-wrap items-center gap-2">
                        <Button
                            :label="t(`capabilities.hostConnectDialog.nameIt`, { name: hostnameSuggestion })"
                            size="small"
                            :loading="renaming"
                            @click="takeHostname"
                        />
                        <span class="text-2xs text-subtle">{{ t(`capabilities.hostConnectDialog.orKeep`, { id }) }}</span>
                    </div>
                </div>
            </template>

            <div v-else-if="error" class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-content">{{ error }}</div>

            <div v-else-if="minting || pairToken === undefined" class="text-sm text-muted">
                {{ t(`shared.preparingOneTimeConnection`) }}
            </div>

            <template v-else>
                <!-- Above the command, because they rewrite it: where to run it on a PC that has both, then the script source. -->
                <div v-if="distros.length > 0" class="flex flex-wrap items-center gap-2 text-2xs text-muted">
                    <span>{{ t(`capabilities.hostConnectDialog.run`) }}</span>
                    <SegmentedControl v-model="via" :options="VIA_OPTIONS" size="xs" />
                    <template v-if="via === `powershell` && distroOptions.length > 1">
                        <span>{{ t(`capabilities.hostConnectDialog.inside`) }}</span>
                        <SegmentedControl v-model="distro" :options="distroOptions" size="xs" />
                    </template>
                </div>
                <ScriptSourceSwitch />
                <Code :code="command" :lang="platform === `windows` || fromPowerShell ? `powershell` : `bash`" :wrap="true" />
                <p class="text-2xs text-subtle">
                    {{ t(`capabilities.hostConnectDialog.codeInCommandWorks`) }}
                </p>
            </template>

            <div class="rounded-md border border-subtle px-3 py-2">
                <p class="text-2xs text-muted">
                    {{ t(`shared.onceConnectedAgentMay`) }} <b>{{ permissions }}</b
                    >{{ t(`capabilities.hostConnectDialog.nothingElseThoseSwitches`) }}
                </p>
            </div>
        </div>

        <template #footer>
            <Button
                :label="online || renamedTo !== undefined ? t(`ui.action.done`) : t(`ui.action.close`)"
                size="small"
                @click="emit(`update:visible`, false)"
            />
        </template>
    </Modal>
</template>
