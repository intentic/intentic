<script setup lang="ts">
import { type S2sContact, S2sGrantsSchema, type S2sGrantsUpdate } from "@intentic/sandbox-contract/schemas/s2s";
import { Avatar, Button, ConfirmDialog, Notice, Row, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { ref, shallowRef } from "vue";
import { identityHue } from "../../../../lib/identityHue";
import Fingerprint from "../../../../parts/messages/Fingerprint.vue";
import { grantsLine } from "../../../../models/messages/grantWords";
import { useMessagesApi } from "../../../../models/messages/messagesApi";
import { withGrants } from "../../../../models/messages/messagesView";
import { contactsChanged } from "../../../../models/messages/useMessages";
import GrantsEditor from "./GrantsEditor.vue";

// A SANDBOX ASKING TO BE A CONTACT, waiting on a person here: who it says it is (its name and the address its document
// was fetched from, so it cannot claim one it does not control), the key it showed, its note in its own words (plain text),
// and what it offers this sandbox there. Accept takes it with the grants set here, messages alone unless more are turned on;
// Block files its address and key, and from then on it is answered as if accepted and nothing it sends is kept, so the
// block tells it nothing. Both are a maintainer's, as the daemon floors them.

const props = defineProps<{ contact: S2sContact; manages: boolean }>();

const t = useT();
const api = useMessagesApi();

// Messages alone unless more are turned on, which is the common answer, so the switches stay folded until asked for.
const grants = shallowRef(S2sGrantsSchema.parse({}));
const changing = ref(false);
const change = (patch: S2sGrantsUpdate): void => {
    grants.value = withGrants(grants.value, patch);
};

const busy = ref(false);
const notice = shallowRef<ReturnType<typeof noticeFrom>>();
const answer = async (task: () => Promise<S2sContact>, failed: string): Promise<boolean> => {
    busy.value = true;
    notice.value = undefined;
    try {
        await task();
        await contactsChanged();
        return true;
    } catch (error) {
        notice.value = noticeFrom(error, failed);
        return false;
    } finally {
        busy.value = false;
    }
};
const accept = (): Promise<boolean> => answer(() => api.acceptContact(props.contact.id, grants.value), t(`sandbox.messages.requests.acceptFailed`));
const blocking = ref(false);
const block = async (): Promise<void> => {
    if (await answer(() => api.blockContact(props.contact.id), t(`sandbox.messages.requests.blockFailed`))) {
        blocking.value = false;
    }
};
</script>

<template>
    <Row lead="face" :title="contact.name" :description="contact.address" :data-request="contact.id">
        <template #lead="{ mark }">
            <Avatar :size="mark" :name="contact.name" :hue="identityHue(contact.id)" />
        </template>
        <template #meta>{{ t(`sandbox.messages.requests.asked`, { ago: timeAgo(contact.createdAt, { days: true }) }) }}</template>
        <template #below>
            <div class="flex flex-col gap-3">
                <blockquote class="whitespace-pre-wrap break-words border-l-2 border-line-strong pl-3 text-sm text-content">
                    {{ contact.note ?? t(`sandbox.messages.requests.noNote`) }}
                </blockquote>
                <div class="flex flex-col gap-1">
                    <span class="text-2xs text-subtle">{{ t(`sandbox.messages.requests.itsKey`) }}</span>
                    <Fingerprint :fingerprint="contact.fingerprint" />
                </div>
                <p v-if="contact.theirGrants" class="text-xs text-muted">{{ t(`sandbox.messages.requests.offers`, { grants: grantsLine(contact.theirGrants) }) }}</p>
                <template v-if="manages">
                    <div class="flex flex-col gap-1.5">
                        <p class="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
                            <span>{{ t(`sandbox.messages.requests.acceptWith`) }}: {{ grantsLine(grants) }}</span>
                            <button v-if="!changing" type="button" :class="ui.textButton({ size: `xs`, flush: true })" data-change-grants @click="changing = true">
                                {{ t(`sandbox.messages.requests.change`) }}
                            </button>
                        </p>
                        <GrantsEditor v-if="changing" :grants="grants" :personal="contact.scope.kind === `person`" :disabled="busy" @change="change" />
                    </div>
                    <Notice v-if="notice" :of="notice" />
                    <div class="flex items-center justify-end gap-2">
                        <Button :label="t(`sandbox.messages.requests.block`)" size="small" tier="quiet" tone="danger" :disabled="busy" @click="blocking = true" />
                        <Button tier="accent" size="small" :label="t(`sandbox.messages.requests.accept`)" :loading="busy && !blocking" :disabled="busy" data-accept @click="accept">
                            <template #icon><Icon name="check" /></template>
                        </Button>
                    </div>
                </template>
                <p v-else class="text-xs text-subtle">{{ t(`sandbox.messages.requests.maintainerAnswers`) }}</p>
            </div>
        </template>
    </Row>

    <ConfirmDialog
        :open="blocking"
        :header="t(`sandbox.messages.requests.blockAsk`, { name: contact.name })"
        :description="t(`sandbox.messages.requests.blockWhat`)"
        :confirm-label="t(`sandbox.messages.requests.block`)"
        destructive
        :loading="busy"
        @confirm="block"
        @cancel="blocking = false"
    />
</template>
