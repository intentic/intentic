<script setup lang="ts">
import { Code } from "@intentic/ui";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import { computed, onBeforeUnmount, watch } from "vue";
import { useHostConnect } from "../composables/sandbox/useHostConnect";

/* "Connect this computer" for a `host`-kind capability. The counterpart of the browser-login dialog: that one
 * signs a session in FOR the user, this one hands them a command to run ON the machine they want connected —
 * because the one thing a browser tab cannot do is install something on a computer that isn't this one.
 *
 * The dialog is deliberately blunt about what the command does and what the machine will then be allowed to do,
 * since it is the moment a person decides to give an agent hands on their computer. The permissions shown are
 * the capability's own config, so the sentence they read here is the same grant the machine will enforce.
 *
 * Once the machine connects, this flips to a confirmation without a refresh — the composable polls while a
 * pairing is live, and the machine coming online is exactly what the user is standing there waiting for. */

const props = defineProps<{ visible: boolean; id: string; platform: string; permissions: string }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "connected"): void }>();

const { hostFor, pairToken, minting, error, linuxCommand, windowsCommand, connect, start, stop, close } = useHostConnect();

const host = computed(() => hostFor(props.id));
const online = computed(() => host.value?.online === true);
const command = computed(() => (props.platform === `windows` ? windowsCommand.value : linuxCommand.value));
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
    <Dialog
        :visible="visible"
        modal
        :header="`Connect ${id}`"
        :style="{ width: '44rem', maxWidth: '92vw' }"
        @update:visible="emit(`update:visible`, $event)"
    >
        <div class="flex flex-col gap-4">
            <p class="text-sm text-content">
                Run this on <b>{{ id }}</b> — in {{ shell }}, as yourself. It installs a small agent that dials this sandbox and keeps one outbound
                connection open. No ports are opened on your network and there is nothing to configure on your router.
            </p>

            <div v-if="online" class="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-content">
                <b>{{ id }}</b> is connected. The agent can work on it from its next turn.
            </div>

            <div v-else-if="error" class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-content">{{ error }}</div>

            <div v-else-if="minting || pairToken === undefined" class="text-sm text-muted">Preparing a one-time connection code…</div>

            <template v-else>
                <Code :code="command" :lang="platform === `windows` ? `powershell` : `bash`" :wrap="true" />
                <p class="text-2xs text-subtle">
                    The code in this command works once and expires in about ten minutes. This window updates by itself when the computer connects.
                </p>
            </template>

            <div class="rounded-md border border-subtle px-3 py-2">
                <p class="text-2xs text-muted">
                    Once connected, the agent may: <b>{{ permissions }}</b> — and nothing else. Those switches live on this card, the computer
                    enforces them itself, and Revoke here cuts it off immediately.
                </p>
            </div>
        </div>

        <template #footer>
            <Button :label="online ? `Done` : `Close`" size="small" @click="emit(`update:visible`, false)" />
        </template>
    </Dialog>
</template>
