<!-- A contact need's own answer (docs/architecture/messages.md): an agent never makes or accepts a contact itself, it asks,
     and a person's press here does it. Add sends the handshake to the address with the grants the agent proposed; Accept
     takes the waiting request with them. Either is a maintainer's, as the daemon floors both, so the press performs it here
     first, then answers the need, which the daemon meets once the contact is there. Anyone else reads whom it waits on. -->
<script setup lang="ts">
import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import type { ContactNeed } from "@intentic/sandbox-contract/schemas/s2s";
import { Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ChatDecisionButton from "../../components/ChatDecisionButton.vue";
import { supportsRoute } from "../../client/sandbox/useDaemonRoutes";
import { useTier } from "../../client/sandbox/useTier";
import { useNeeds } from "../../models/needs/useNeeds";
import Fingerprint from "../../parts/messages/Fingerprint.vue";
import { grantsLine } from "../../models/messages/grantWords";
import { useMessagesApi } from "../../models/messages/messagesApi";
import { contactsChanged, useContacts } from "../../models/messages/useMessages";
import { useNeedAnswer } from "./needAnswer";

const t = useT();

const props = defineProps<{ need: Need; subject: ContactNeed }>();

const needs = useNeeds();
const api = useMessagesApi();
const { canShip } = useTier();
const served = computed(() => supportsRoute(props.subject.action === `add` ? `POST /s2s/contacts` : `POST /s2s/contacts/{id}/accept`));

// The key, once one is known here: the waiting request's, or a contact already filed for the address.
const { contacts } = useContacts(canShip);
const known = computed(() => contacts.value.find((contact) => contact.id === props.subject.contactId || contact.address === props.subject.address));
const lead = computed(() => {
    const grants = grantsLine(props.subject.grants);
    return props.subject.action === `add`
        ? t(`needs.contact.leadAdd`, { address: props.subject.address, grants })
        : t(`needs.contact.leadAccept`, { address: known.value?.name ?? props.subject.address, grants });
});

const { busy, notice, answer } = useNeedAnswer(() => props.need);
const perform = async (): Promise<void> => {
    const { action, address, contactId, grants, note } = props.subject;
    const id = props.need.id;
    await answer({
        failed: t(`needs.card.couldNotAnswer`),
        task: async () => {
            if (action === `accept`) {
                await api.acceptContact(contactId ?? known.value?.id ?? ``, grants);
            } else if (known.value === undefined) {
                await api.addContact(note === undefined ? { address, grants } : { address, note, grants });
            }
            await contactsChanged();
            await needs.answer.mutateAsync({ id, answer: { kind: `approve` } });
        },
    });
};
</script>

<template>
    <div class="chat-card-body flex flex-col gap-2">
        <p class="text-xs text-content/85">{{ lead }}</p>
        <div v-if="known" class="flex flex-col gap-0.5">
            <span class="text-2xs text-subtle">{{ t(`needs.contact.fingerprint`) }}</span>
            <Fingerprint :fingerprint="known.fingerprint" />
        </div>
        <blockquote v-if="subject.note ?? known?.note" class="whitespace-pre-wrap break-words border-l-2 border-line-strong pl-2 text-xs text-content/85">
            {{ subject.note ?? known?.note }}
        </blockquote>
        <div v-if="need.status === `open`" class="flex flex-wrap items-center gap-2">
            <template v-if="canShip">
                <ChatDecisionButton v-if="served" tone="primary" icon="check" :disabled="busy" @click="perform">
                    {{ subject.action === `add` ? t(`needs.contact.add`) : t(`needs.contact.accept`) }}
                </ChatDecisionButton>
                <span v-else class="text-2xs text-subtle" data-contact-old>{{ t(`needs.contact.tooOld`) }}</span>
            </template>
            <span v-else class="text-2xs text-subtle" data-contact-waits>{{ t(`needs.contact.maintainerOnly`) }}</span>
            <slot name="decline" />
        </div>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
