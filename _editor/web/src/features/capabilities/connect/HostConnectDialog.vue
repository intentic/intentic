<script setup lang="ts">
import type { HostSummary } from "@intentic/sandbox-contract";
import { Button, Code, Modal } from "@intentic/ui";
import { computed, onBeforeUnmount, watch } from "vue";
import { HOST_DOOR, usePeerConnect } from "../../sandbox/devices/usePeerConnect";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { bashCommand, psCommand } from "../../../app/environments/scriptCommand";
import ScriptSourceSwitch from "./ScriptSourceSwitch.vue";

// Connect-this-device dialog for a host-kind capability: a tab can't install anything on another machine, so this
// hands over a command instead. States the command and the exact permissions the machine will enforce. Flips to a
// live confirmation once the machine connects, no refresh needed.

const props = defineProps<{ visible: boolean; id: string; platform: string; permissions: string }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "connected"): void }>();

const { peerFor, pairToken, minting, error, connect, start, stop, close } = usePeerConnect<HostSummary>(HOST_DOOR);
const { daemonUrl } = useSandbox();

const host = computed(() => peerFor(props.id));
const online = computed(() => host.value?.online === true);
const command = computed(() => {
    const url = daemonUrl.value ?? ``;
    if (url === `` || pairToken.value === undefined) {
        return ``;
    }
    return props.platform === `windows`
        ? psCommand(`devicePs1`, `$env:SANDBOX_URL='${url}'; $env:PAIR_TOKEN='${pairToken.value}'; `)
        : bashCommand(`deviceSh`, `env SANDBOX_URL='${url}' PAIR_TOKEN='${pairToken.value}' `, ``);
});
const shell = computed(() => (props.platform === `windows` ? `PowerShell` : `a terminal`));

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
                <!-- Above the command, because it rewrites it. -->
                <ScriptSourceSwitch />
                <Code :code="command" :lang="platform === `windows` ? `powershell` : `bash`" :wrap="true" />
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
