<script setup lang="ts">
import type { HostSummary } from "@intentic/sandbox-contract";
import { Button, Code, Modal, SegmentedControl } from "@intentic/ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useDevices } from "../../sandbox/devices/useDevices";
import { HOST_DOOR, usePeerConnect } from "../../sandbox/devices/usePeerConnect";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { bashCommand, psCommand } from "../../../app/environments/scriptCommand";
import ScriptSourceSwitch from "./ScriptSourceSwitch.vue";

// Connect-this-device dialog for a host-kind capability: a tab can't install anything on another machine, so this
// hands over a command instead. States the command and the exact permissions the machine will enforce. Flips to a
// live confirmation once the machine connects, no refresh needed. A Linux device that is a WSL distro of a Windows
// PC already connected can take its command from PowerShell, where a reader on that PC is sitting.

const props = defineProps<{ visible: boolean; id: string; platform: string; permissions: string }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "connected"): void }>();

const { peerFor, pairToken, minting, error, connect, start, stop, close } = usePeerConnect<HostSummary>(HOST_DOOR);
const { daemonUrl } = useSandbox();

// The distros every connected Windows PC lists, read off the fleet already held (no poll): the Linux one-liner can
// be run inside one from PowerShell, so a reader on that PC never has to open the distro's own terminal first.
const { devices } = useDevices({ poll: false });
const distros = computed(() =>
    props.platform === `linux` ? [...new Set(devices.value.flatMap((device) => device.facts?.wslDistros ?? []))] : [],
);
type Via = `terminal` | `powershell`;
const VIA_OPTIONS: { label: string; value: Via; title: string }[] = [
    { label: `A terminal in the distro`, value: `terminal`, title: `Run it inside the Linux environment itself` },
    { label: `PowerShell`, value: `powershell`, title: `Run it from Windows, inside the distro, through wsl.exe` },
];
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
const distroOptions = computed(() => distros.value.map((name) => ({ label: name, value: name, title: `Run it inside ${name}` })));

const host = computed(() => peerFor(props.id));
const online = computed(() => host.value?.online === true);
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
    <Modal :open="visible" size="lg" :header="`Connect ${id}`" @update:open="emit(`update:visible`, $event)">
        <div class="flex flex-col gap-4">
            <p class="text-sm text-content">
                Run this on <b>{{ id }}</b
                >: in {{ shell }}, as yourself. It installs a small agent that dials this sandbox and keeps one outbound connection open. No ports are
                opened on your network and there is nothing to configure on your router.
            </p>

            <div v-if="online" class="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-content">
                <b>{{ id }}</b> is connected. The agent can work on it from its next turn.
            </div>

            <div v-else-if="error" class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-content">{{ error }}</div>

            <div v-else-if="minting || pairToken === undefined" class="text-sm text-muted">Preparing a one-time connection code…</div>

            <template v-else>
                <!-- Above the command, because they rewrite it: where to run it on a PC that has both, then the script source. -->
                <div v-if="distros.length > 0" class="flex flex-wrap items-center gap-2 text-2xs text-muted">
                    <span>Run it from</span>
                    <SegmentedControl v-model="via" :options="VIA_OPTIONS" size="xs" />
                    <template v-if="via === `powershell` && distroOptions.length > 1">
                        <span>inside</span>
                        <SegmentedControl v-model="distro" :options="distroOptions" size="xs" />
                    </template>
                </div>
                <ScriptSourceSwitch />
                <Code :code="command" :lang="platform === `windows` || fromPowerShell ? `powershell` : `bash`" :wrap="true" />
                <p class="text-2xs text-subtle">
                    The code in this command works once and expires in about ten minutes. This window updates by itself when the device connects.
                </p>
            </template>

            <div class="rounded-md border border-subtle px-3 py-2">
                <p class="text-2xs text-muted">
                    Once connected, the agent may: <b>{{ permissions }}</b
                    >, and nothing else. Those switches live on this card, the device enforces them itself, and Revoke here cuts it off immediately.
                </p>
            </div>
        </div>

        <template #footer>
            <Button :label="online ? `Done` : `Close`" size="small" @click="emit(`update:visible`, false)" />
        </template>
    </Modal>
</template>
