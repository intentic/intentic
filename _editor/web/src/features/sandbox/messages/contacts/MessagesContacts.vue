<script setup lang="ts">
import { Await, Button, InfoHint, Notice, Row, RowGroup, RowNote } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, shallowRef } from "vue";
import { useTier } from "../../../../client/sandbox/useTier";
import { useMessagesApi } from "../../../../models/messages/messagesApi";
import { contactSections, shortFingerprint, tasksOfContact } from "../../../../models/messages/messagesView";
import { contactsChanged, useContactTasks, useContacts } from "../../../../models/messages/useMessages";
import AddContactForm from "./AddContactForm.vue";
import ContactRequest from "./ContactRequest.vue";
import ContactRow from "./ContactRow.vue";
import PairContactForm from "./PairContactForm.vue";
import WaitingTasks from "./WaitingTasks.vue";

// MESSAGES ▸ CONTACTS: the sandboxes this one knows. What asks something of the reader comes first: requests waiting on
// a person, and tasks contacts handed this sandbox that wait for the owner's Allow. Then every contact by name, each with
// its key's standing, what it may do here and the tasks it handed this sandbox; then the blocked ones, quietly, to unblock.
// A contact is added by address (the handshake, a maintainer's) or by pairing with one of the reader's own sandboxes;
// each form opens at the top of the list it adds to. A link naming a contact (`?open=<contact>`) opens it.

const { open = undefined } = defineProps<{
    // A contact a link names, as the push saying one of its tasks waits does.
    open?: string;
}>();

const t = useT();
const api = useMessagesApi();
const { canShip } = useTier();

const { contacts, loaded } = useContacts();
const sections = computed(() => contactSections(contacts.value));
const { tasks, waiting } = useContactTasks();

const adding = ref<`address` | `pair`>();

const unblocking = ref<string>();
const notice = shallowRef<ReturnType<typeof noticeFrom>>();
const unblock = async (id: string): Promise<void> => {
    unblocking.value = id;
    notice.value = undefined;
    try {
        await api.removeContact(id);
        await contactsChanged();
    } catch (error) {
        notice.value = noticeFrom(error, t(`sandbox.messages.contacts.unblockFailed`));
    } finally {
        unblocking.value = undefined;
    }
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <RowGroup v-if="sections.waiting.length > 0" :label="t(`sandbox.messages.requests.title`)" data-requests>
            <ContactRequest v-for="contact in sections.waiting" :key="contact.id" :contact="contact" :manages="canShip" />
        </RowGroup>
        <WaitingTasks v-if="waiting.length > 0" :tasks="waiting" :manages="canShip" />

        <RowGroup :label="t(`sandbox.messages.contacts.title`)">
            <template #info>
                <InfoHint :label="t(`sandbox.messages.contacts.about`)">
                    <span class="block text-xs text-content">{{ t(`sandbox.messages.contacts.aboutBody`) }}</span>
                </InfoHint>
            </template>
            <template #actions>
                <Button v-if="canShip" :label="t(`sandbox.messages.contacts.addByAddress`)" size="small" tier="boring" @click="adding = `address`">
                    <template #icon><Icon name="plus" /></template>
                </Button>
                <Button :label="t(`sandbox.messages.contacts.pair`)" size="small" tier="boring" @click="adding = `pair`">
                    <template #icon><Icon name="link" /></template>
                </Button>
            </template>

            <RowNote v-if="adding" variant="block">
                <AddContactForm v-if="adding === `address`" @done="adding = undefined" @cancel="adding = undefined" />
                <PairContactForm v-else @done="adding = undefined" @cancel="adding = undefined" />
            </RowNote>
            <Await :of="loaded">
                <ContactRow
                    v-for="contact in sections.known"
                    :key="contact.id"
                    :contact="contact"
                    :manages="canShip"
                    :tasks="tasksOfContact(tasks, contact.id)"
                    :opened="contact.id === open"
                />
                <RowNote v-if="sections.known.length === 0 && adding === undefined" variant="empty">{{ t(`sandbox.messages.contacts.empty`) }}</RowNote>
            </Await>
        </RowGroup>

        <RowGroup v-if="sections.blocked.length > 0" :label="t(`sandbox.messages.contacts.blocked`)" data-blocked>
            <Row v-for="contact in sections.blocked" :key="contact.id" icon="lock" :title="contact.name" :description="contact.name === contact.address ? shortFingerprint(contact.fingerprint) : `${contact.address} · ${shortFingerprint(contact.fingerprint)}`">
                <template v-if="canShip" #control>
                    <Button
                        :label="t(`sandbox.messages.contacts.unblock`)"
                        size="small"
                        tier="quiet"
                        :loading="unblocking === contact.id"
                        :disabled="unblocking !== undefined"
                        @click="unblock(contact.id)"
                    />
                </template>
            </Row>
            <RowNote v-if="notice" variant="block"><Notice :of="notice" /></RowNote>
        </RowGroup>
    </div>
</template>
