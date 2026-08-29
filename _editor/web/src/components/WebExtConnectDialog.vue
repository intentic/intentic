<script setup lang="ts">
import { Button, Code, Modal } from "@intentic/ui";
import { computed, onBeforeUnmount, watch } from "vue";
import { useWebExtConnect } from "../composables/sandbox/useWebExtConnect";

/* "Connect this browser" for a `webext`-kind capability. The machine dialog's sibling: that one hands over a
 * command to run on a computer this tab cannot reach, and this one hands over a code to paste into a browser
 * this tab may not be running in.
 *
 * It is blunt about what the connection can and cannot do, because this is the moment a person decides to let
 * an agent into the browser their bank is open in. The sentence that matters most is the one about SITES: the
 * switches on this card decide what KIND of thing may happen, and which sites it may happen on is a separate
 * decision they make in the extension, in their browser, one site at a time — and can take back there.
 *
 * When the extension is already installed in THIS browser it answers the handoff and the code disappears: a
 * person connecting the browser they are reading this in copies nothing. */

// `install` is empty when the card that declared this browser family named no store listing — an
// unlisted build, or a family somebody added by hand. The link is then simply not offered.
const props = defineProps<{ visible: boolean; id: string; install: string; permissions: string }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "connected"): void }>();

const { browserFor, code, minting, error, extensionHere, connect, start, stop, close } = useWebExtConnect();

const browser = computed(() => browserFor(props.id));
const online = computed(() => browser.value?.online === true);

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

// The moment the extension reports in, tell the page so the capability's status refreshes behind the dialog.
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
                Install the Intentic extension in the browser you want to connect, then give it the code below. The extension keeps one outbound
                connection open to this sandbox while that browser is running. Nothing is opened on your network, and nothing is copied out of your
                browser.
            </p>

            <div v-if="online" class="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-content">
                <b>{{ id }}</b> is connected. Allow it on a site in the extension, and the agent can work there from its next turn.
            </div>

            <div v-else-if="error" class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-content">{{ error }}</div>

            <div v-else-if="minting || code === ``" class="text-sm text-muted">Preparing a one-time connection code…</div>

            <template v-else>
                <!-- The extension in THIS browser already has the code: nothing to copy, and saying so is what
                     stops somebody pasting it a second time and wondering why it expired. -->
                <div v-if="extensionHere === true" class="rounded-md border border-subtle px-3 py-2 text-sm text-content">
                    Your extension has the code. Open it (the toolbar icon is showing <b>!</b>) and press <b>Connect</b>.
                </div>
                <template v-else>
                    <a v-if="install !== ``" :href="install" target="_blank" rel="noreferrer" class="text-sm underline">Install the extension →</a>
                    <Code :code="code" :wrap="true" />
                    <p class="text-2xs text-subtle">
                        Paste it into the extension's popup. The code works once and expires in about ten minutes. This window updates by itself when
                        the browser connects.
                    </p>
                </template>
            </template>

            <div class="rounded-md border border-subtle px-3 py-2">
                <p class="text-2xs text-muted">
                    Once connected, the agent may: <b>{{ permissions }}</b
                    >, and only on the sites you allow one at a time in the extension — your browser enforces that part, not this sandbox. Pause it
                    from the extension, or Revoke here, and it stops immediately.
                </p>
            </div>
        </div>

        <template #footer>
            <Button :label="online ? `Done` : `Close`" size="small" @click="emit(`update:visible`, false)" />
        </template>
    </Modal>
</template>
