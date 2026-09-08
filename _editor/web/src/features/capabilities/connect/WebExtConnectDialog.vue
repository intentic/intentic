<script setup lang="ts">
import { WEBEXT_PAIR_MESSAGE, WEBEXT_PAIRED_MESSAGE, type WebExtSummary, webextPairingCode } from "@intentic/sandbox-contract";
import { Button, Code, Modal } from "@intentic/ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { usePeerConnect, WEBEXT_DOOR } from "../../sandbox/devices/usePeerConnect";
import { useSandbox } from "../../sandbox/client/useSandbox";

// "Connect this browser" for a webext-kind capability: hands over a code to paste into a browser this tab may not
// run in. Site access stays a separate, per-site decision made later in the extension. The code also posts on this
// window so an installed extension can pick it up without copying; either way still needs a click in its popup.

// `install` is empty when the card named no store listing (unlisted build, hand-added family); the link is then
// omitted.
const props = defineProps<{ visible: boolean; id: string; install: string; permissions: string }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "connected"): void }>();

const { peerFor, pairToken, minting, error, connect, start, stop, close } = usePeerConnect<WebExtSummary>(WEBEXT_DOOR);
const { daemonUrl } = useSandbox();

const browser = computed(() => peerFor(props.id));
const online = computed(() => browser.value?.online === true);
const code = computed(() => {
    const url = daemonUrl.value ?? ``;
    return url === `` || pairToken.value === undefined ? `` : webextPairingCode({ url, token: pairToken.value });
});

// Whether an installed extension answered; undefined (not yet offered) differs from false (nothing answered).
const extensionHere = ref<boolean | undefined>(undefined);
// Extension answers on this window; one listener per offer, removed on close so a stale one can't mark a later
// attempt.
let listener: ((event: MessageEvent) => void) | undefined;
const forgetOffer = (): void => {
    extensionHere.value = undefined;
    if (listener !== undefined) {
        window.removeEventListener(`message`, listener);
        listener = undefined;
    }
};
const offer = (): void => {
    if (code.value === ``) {
        return;
    }
    forgetOffer();
    listener = (event: MessageEvent) => {
        if (event.source === window && (event.data as { type?: unknown } | undefined)?.type === WEBEXT_PAIRED_MESSAGE) {
            extensionHere.value = true;
        }
    };
    window.addEventListener(`message`, listener);
    window.postMessage({ type: WEBEXT_PAIR_MESSAGE, code: code.value }, window.location.origin);
    // No answer within a moment means no extension here, the ordinary case when connecting a different browser.
    setTimeout(() => {
        extensionHere.value ??= false;
    }, 1200);
};

// Opening mints, then offers; closing forgets. A pairing left live in a closed tab is a credential nobody is watching.
watch(
    () => props.visible,
    async (visible) => {
        if (!visible) {
            forgetOffer();
            close();
            stop();
            return;
        }
        start();
        await connect(props.id);
        offer();
    },
);

// The moment the extension reports in, tell the page so the capability's status refreshes behind the dialog.
watch(online, (isOnline) => {
    if (isOnline) {
        emit(`connected`);
    }
});

onBeforeUnmount(() => {
    forgetOffer();
    stop();
});
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
                <!--
                    Extension in this browser already has the code: nothing to copy, so say so instead of risking a
                    second paste.
                -->
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
