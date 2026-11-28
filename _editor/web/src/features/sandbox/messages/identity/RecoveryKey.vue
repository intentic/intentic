<script setup lang="ts">
import { S2S_RECOVERY_SECRET_PREFIX, type S2sMe, type S2sRecoveryMinted } from "@intentic/sandbox-contract/schemas/s2s";
import { Button, ConfirmDialog, CopyButton, InfoHint, Notice, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, shallowRef } from "vue";
import { useMessagesApi } from "../../../../models/messages/messagesApi";
import { shortFingerprint } from "../../../../models/messages/messagesView";
import { identityChanged } from "../../../../models/messages/useMessages";
import { useIdentityWrite } from "./useIdentityWrite";

// THE RECOVERY KEY, the owner's alone: made on request, its secret shown this once to be kept off the sandbox (only its
// fingerprint is published), and pasted back to recover the identity on a sandbox whose volume was lost, which then
// makes a new key vouched for by it. Replacing it makes the old one useless.

const props = defineProps<{ me: S2sMe }>();

const t = useT();
const api = useMessagesApi();
const { busy, notice, run } = useIdentityWrite();

const recoveryLine = computed(() => {
    const fingerprint = props.me.document.recovery;
    return props.me.recovery
        ? t(`sandbox.messages.recovery.set`, { fingerprint: fingerprint === undefined ? `` : shortFingerprint(fingerprint) })
        : t(`sandbox.messages.recovery.none`);
});

const minted = shallowRef<S2sRecoveryMinted>();
const replacing = ref(false);
const mint = async (): Promise<void> => {
    replacing.value = false;
    await run(
        `mint`,
        async () => {
            minted.value = await api.mintRecovery();
            await identityChanged();
            return undefined;
        },
        t(`sandbox.messages.recovery.mintFailed`),
    );
};
const ask = (): void => {
    if (props.me.recovery) {
        replacing.value = true;
        return;
    }
    void mint();
};

const recovering = ref(false);
const confirmRecover = ref(false);
const secret = ref(``);
const recover = async (): Promise<void> => {
    const pasted = secret.value.trim();
    if (pasted !== `` && (await run(`recover`, () => api.recover(pasted), t(`sandbox.messages.recovery.recoverFailed`)))) {
        secret.value = ``;
        recovering.value = false;
        confirmRecover.value = false;
    } else {
        confirmRecover.value = false;
    }
};
</script>

<template>
    <RowGroup :label="t(`sandbox.messages.recovery.title`)" data-recovery>
        <template #info>
            <InfoHint :label="t(`sandbox.messages.recovery.about`)">
                <span class="block text-xs text-content">{{ t(`sandbox.messages.recovery.aboutBody`) }}</span>
            </InfoHint>
        </template>
        <Row icon="shield" :title="t(`sandbox.messages.recovery.key`)" :description="recoveryLine">
            <template #control>
                <Button
                    :label="me.recovery ? t(`sandbox.messages.recovery.replace`) : t(`sandbox.messages.recovery.make`)"
                    size="small"
                    tier="boring"
                    :loading="busy === `mint`"
                    :disabled="busy !== undefined"
                    @click="ask"
                />
            </template>
        </Row>

        <!-- Shown this once: the secret, its copy, and where it must go. -->
        <RowNote v-if="minted" variant="block">
            <div class="flex flex-col gap-2 rounded-lg bg-canvas p-3" data-recovery-secret>
                <p class="text-xs font-medium text-warning">{{ t(`sandbox.messages.recovery.keepOff`) }}</p>
                <div class="flex items-center gap-2">
                    <code class="min-w-0 flex-1 break-all font-mono text-xs text-content">{{ minted.secret }}</code>
                    <CopyButton :text="minted.secret" :label="t(`ui.action.copy`)" cta />
                </div>
                <div class="flex justify-end">
                    <Button :label="t(`sandbox.messages.recovery.kept`)" size="small" tier="quiet" @click="minted = undefined" />
                </div>
            </div>
        </RowNote>

        <Row icon="undo" :title="t(`sandbox.messages.recovery.recoverTitle`)" :description="t(`sandbox.messages.recovery.recoverLine`)">
            <template #control>
                <Button v-if="!recovering" :label="t(`sandbox.messages.recovery.recover`)" size="small" tier="quiet" @click="recovering = true" />
            </template>
        </Row>
        <RowNote v-if="recovering" variant="block">
            <form class="flex flex-col gap-2" @submit.prevent="confirmRecover = true">
                <textarea
                    v-model="secret"
                    rows="2"
                    autocomplete="off"
                    spellcheck="false"
                    :placeholder="`${S2S_RECOVERY_SECRET_PREFIX}…`"
                    :aria-label="t(`sandbox.messages.recovery.paste`)"
                    :class="ui.input({ size: `sm` }, `w-full resize-none font-mono`)"
                />
                <div class="flex items-center justify-end gap-2">
                    <Button :label="t(`ui.action.cancel`)" size="small" tier="quiet" :disabled="busy !== undefined" @click="recovering = false" />
                    <Button tier="accent" tone="danger" type="submit" size="small" :label="t(`sandbox.messages.recovery.recover`)" :disabled="busy !== undefined || secret.trim() === ``" />
                </div>
            </form>
        </RowNote>
        <RowNote v-if="notice" variant="block"><Notice :of="notice" /></RowNote>

        <ConfirmDialog
            :open="replacing"
            :header="t(`sandbox.messages.recovery.replaceAsk`)"
            :description="t(`sandbox.messages.recovery.replaceWhat`)"
            :confirm-label="t(`sandbox.messages.recovery.replace`)"
            tone="warning"
            @confirm="mint"
            @cancel="replacing = false"
        />
        <ConfirmDialog
            :open="confirmRecover"
            :header="t(`sandbox.messages.recovery.recoverAsk`)"
            :description="t(`sandbox.messages.recovery.recoverWhat`)"
            :confirm-label="t(`sandbox.messages.recovery.recover`)"
            destructive
            :loading="busy === `recover`"
            @confirm="recover"
            @cancel="confirmRecover = false"
        />
    </RowGroup>
</template>
