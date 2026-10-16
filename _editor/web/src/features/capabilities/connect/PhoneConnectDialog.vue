<script setup lang="ts">
import { phonePairingCode, phonePairingLink } from "@intentic/sandbox-contract/protocol/doors/phone-links";
import { Button, Code, Modal, Notice, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { renderSVG } from "uqr";
import { computed, ref, watch } from "vue";
import { PHONE_DOOR, usePeerConnect } from "../../../models/sandbox/devices/usePeerConnect";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { registerWakeOnce, type WakeOutcome } from "./phoneWake";

// "Connect this phone" for a phone-kind capability: a QR code the phone's camera scans, which opens the Intentic Device
// app on its pairing screen (or the page offering the app, on a phone without it). On the phone itself the same link
// is a button. The code is drawn here, in the page: it carries a live pairing token, so it never goes to a QR service.
// Once the phone checks in, the dialog makes it wakeable (phoneWake.ts), so the agent can reach it while it sleeps.

const t = useT();

const props = defineProps<{ visible: boolean; id: string; install: string; permissions: string }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "connected"): void }>();

const { peerFor, pairToken, minting, error, rosterNotice, connect, refresh, close } = usePeerConnect(PHONE_DOOR);
const { daemonUrl } = useSandbox();
const { mobile } = useDevice();

const phone = computed(() => peerFor(props.id));
const online = computed(() => phone.value?.online === true);
const pairing = computed(() => {
    const url = daemonUrl.value ?? ``;
    return url === `` || pairToken.value === undefined ? undefined : { url, token: pairToken.value };
});
const link = computed(() => (pairing.value === undefined ? `` : phonePairingLink(pairing.value)));
const code = computed(() => (pairing.value === undefined ? `` : phonePairingCode(pairing.value)));
// Drawn as an SVG string from the link alone, black on white whatever the theme: a camera reads dark-on-light, and a
// code drawn light-on-dark in dark mode is one many phones will not scan.
const qr = computed(() => (link.value === `` ? `` : renderSVG(link.value, { border: 2, whiteColor: `#ffffff`, blackColor: `#000000` })));
const showCode = ref(false);

// Waking is set up once the phone has said what its push token is; `undefined` while there is nothing to do.
const wake = ref<WakeOutcome | undefined>(undefined);
watch(
    () => [online.value, phone.value?.wake, phone.value?.facts?.wake?.fcm] as const,
    async () => {
        if (phone.value !== undefined && online.value) {
            wake.value = (await registerWakeOnce(phone.value)) ?? wake.value;
        }
    },
);

// Opening mints; closing forgets. A pairing left live in a closed tab is a credential nobody is watching.
watch(
    () => props.visible,
    async (visible) => {
        if (!visible) {
            showCode.value = false;
            close();
            return;
        }
        // The roster the pairing is confirmed against is read afresh, not taken from what was cached.
        void refresh();
        await connect(props.id);
    },
);

watch(online, (isOnline) => {
    if (isOnline) {
        emit(`connected`);
    }
});
</script>

<template>
    <Modal
        :open="visible"
        size="lg"
        :header="t(`capabilities.words.connect`, { id })"
        :description="t(`capabilities.phoneConnectDialog.intro`)"
        @update:open="emit(`update:visible`, $event)"
    >
        <div class="flex flex-col gap-4">
            <Notice v-if="online" tone="success">
                <span class="flex flex-col gap-1">
                    <span>
                        <b>{{ id }}</b> {{ t(`capabilities.phoneConnectDialog.connected`) }}
                    </span>
                    <span v-if="wake === `ready` || phone?.wake === `ready`" class="text-xs text-muted">{{
                        t(`capabilities.phoneConnectDialog.wakeReady`)
                    }}</span>
                    <span v-else-if="wake === `unavailable` || phone?.wake === `none`" class="text-xs text-muted">{{
                        t(`capabilities.phoneConnectDialog.wakeUnavailable`)
                    }}</span>
                    <span v-else-if="wake === `failed`" class="text-xs text-warning">{{ t(`capabilities.phoneConnectDialog.wakeFailed`) }}</span>
                </span>
            </Notice>

            <Notice v-else-if="error" tone="danger">{{ error }}</Notice>
            <Notice v-if="rosterNotice" tone="warning">{{ rosterNotice }}</Notice>

            <div v-else-if="minting || link === ``" class="text-muted">
                {{ t(`capabilities.words.preparingOneTimeConnection`) }}
            </div>

            <template v-else>
                <a v-if="install !== ``" :href="install" target="_blank" rel="noreferrer" class="underline">{{
                    t(`capabilities.phoneConnectDialog.getApp`)
                }}</a>
                <!-- On the phone itself there is nothing to scan: the same link opens the app. -->
                <a v-if="mobile" :href="link" class="self-start">
                    <Button :label="t(`capabilities.phoneConnectDialog.openOnThisPhone`)" size="small" />
                </a>
                <div v-else class="flex flex-wrap items-center gap-4">
                    <!-- eslint-disable-next-line vue/no-v-html -- an SVG drawn here from the link alone, no outside markup -->
                    <div
                        class="size-48 shrink-0 rounded-md bg-white p-1 [&>svg]:size-full"
                        role="img"
                        :aria-label="t(`capabilities.phoneConnectDialog.qrLabel`)"
                        v-html="qr"
                    />
                    <p class="min-w-48 flex-1 text-2xs text-subtle">{{ t(`capabilities.phoneConnectDialog.scanWithCamera`) }}</p>
                </div>
                <button type="button" class="self-start text-2xs text-muted underline" @click="showCode = !showCode">
                    {{ t(`capabilities.phoneConnectDialog.cantScan`) }}
                </button>
                <Code v-if="showCode" :code="code" :wrap="true" />
            </template>

            <!-- What connecting grants, as the dialog's closing footnote: on its own ground, not boxed as a second card. -->
            <p class="text-2xs text-muted">
                {{ t(`capabilities.words.onceConnectedAgentMay`) }} <b>{{ permissions }}</b
                >{{ t(`capabilities.phoneConnectDialog.onlyWhatYouAllow`) }}
            </p>
        </div>

        <template #footer>
            <Button
                :label="online ? t(`ui.action.done`) : t(`ui.action.close`)"
                :tier="online ? `accent` : `quiet`"
                @click="emit(`update:visible`, false)"
            />
        </template>
    </Modal>
</template>
