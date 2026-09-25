<script setup lang="ts">
import { WEBEXT_PAIR_MESSAGE, WEBEXT_PAIRED_MESSAGE, type WebExtSummary, webextPairingCode } from "@intentic/sandbox-contract";
import { Button, Code, Modal } from "@intentic/ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { usePeerConnect, WEBEXT_DOOR } from "../../sandbox/devices/usePeerConnect";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { useT } from "@intentic/ui/i18n";

// "Connect this browser" for a webext-kind capability: hands over a code to paste into a browser this tab may not
// run in. Site access stays a separate, per-site decision made later in the extension. The code also posts on this
// window so an installed extension can pick it up without copying; either way still needs a click in its popup.

// `install` is empty when the tile named no store listing (unlisted build, hand-added family); the link is then
// omitted.
const t = useT();

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
    <Modal :open="visible" size="lg" :header="t(`capabilities.words.connect`, { id })" @update:open="emit(`update:visible`, $event)">
        <div class="flex flex-col gap-4">
            <p class="text-sm text-content">
                {{ t(`capabilities.webExtConnectDialog.installIntenticExtensionIn`) }}
            </p>

            <div v-if="online" class="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-content">
                <b>{{ id }}</b> {{ t(`capabilities.webExtConnectDialog.connectedAllowOnSite`) }}
            </div>

            <div v-else-if="error" class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-content">{{ error }}</div>

            <div v-else-if="minting || code === ``" class="text-sm text-muted">
                {{ t(`capabilities.words.preparingOneTimeConnection`) }}
            </div>

            <template v-else>
                <!-- Extension in this browser already has the code: nothing to copy, so say so instead of risking a second paste. -->
                <div v-if="extensionHere === true" class="rounded-md border border-subtle px-3 py-2 text-sm text-content">
                    {{ t(`capabilities.webExtConnectDialog.extensionCodeOpenToolbar`) }} <b>!</b>{{ t(`capabilities.webExtConnectDialog.press`) }}
                    <b>{{ t(`ui.action.connect`) }}</b
                    >.
                </div>
                <template v-else>
                    <a v-if="install !== ``" :href="install" target="_blank" rel="noreferrer" class="text-sm underline">{{
                        t(`capabilities.webExtConnectDialog.installExtension`)
                    }}</a>
                    <Code :code="code" :wrap="true" />
                    <p class="text-2xs text-subtle">
                        {{ t(`capabilities.webExtConnectDialog.pasteIntoExtensionsPopup`) }}
                    </p>
                </template>
            </template>

            <div class="rounded-md border border-subtle px-3 py-2">
                <p class="text-2xs text-muted">
                    {{ t(`capabilities.words.onceConnectedAgentMay`) }} <b>{{ permissions }}</b
                    >{{ t(`capabilities.webExtConnectDialog.onlyOnSitesAllow`) }}
                </p>
            </div>
        </div>

        <template #footer>
            <Button :label="online ? t(`ui.action.done`) : t(`ui.action.close`)" size="small" @click="emit(`update:visible`, false)" />
        </template>
    </Modal>
</template>
