<script setup lang="ts">
import { WEBEXT_PAIR_MESSAGE, WEBEXT_PAIRED_MESSAGE, type WebExtSummary, webextPairingCode } from "@intentic/sandbox-contract";
import { Button, Code, Modal } from "@intentic/ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { usePeerConnect, WEBEXT_DOOR } from "../../sandbox/devices/usePeerConnect";
import { useSandbox } from "../../sandbox/client/useSandbox";

/* "Connect this browser" for a `webext`-kind capability. The machine dialog's sibling: that one hands over a
 * command to run on a device this tab cannot reach, and this one hands over a code to paste into a browser
 * this tab may not be running in.
 *
 * It is blunt about what the connection can and cannot do, because this is the moment a person decides to let
 * an agent into the browser their bank is open in. The sentence that matters most is the one about SITES: the
 * switches on this card decide what KIND of thing may happen, and which sites it may happen on is a separate
 * decision they make in the extension, in their browser, one site at a time — and can take back there.
 *
 * THE HANDOFF IS THE INTERESTING PART. The code is also posted on this window, where the extension's own
 * content script picks it up (it is loaded on this origin and no other), so a person with the extension already
 * installed never copies anything: their popup lights up with "a sandbox wants to connect". The page learns the
 * extension is there from the answer, and says so. Everything still needs their click in the popup — a page
 * must not be able to connect somebody's browser to a sandbox on its own, and Chrome would refuse anyway, since
 * redeeming needs a permission only a user gesture can grant. */

// `install` is empty when the card that declared this browser family named no store listing — an
// unlisted build, or a family somebody added by hand. The link is then simply not offered.
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

// Whether an installed extension answered the handoff. Undefined until we have offered one: "we do not know
// yet" and "nothing answered" are different things to say to somebody who is waiting.
const extensionHere = ref<boolean | undefined>(undefined);
// The extension answers on this same window when it has the code. One listener per offer, removed when the
// dialog closes, so a stale one cannot mark a later attempt as answered.
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
    // Nothing answering within a moment means no extension on this browser, which is the ordinary case when
    // the browser being connected is a different one from the one this page is open in.
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
