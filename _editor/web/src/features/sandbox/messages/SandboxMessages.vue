<script setup lang="ts">
import { RowNote, SegmentedControl } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useTier } from "../../../client/sandbox/useTier";
import { MESSAGES_PARTS, type MessagesPart } from "../../../models/sandbox/sandboxNav";
import MessagesContacts from "./contacts/MessagesContacts.vue";
import MessagesIdentity from "./identity/MessagesIdentity.vue";
import MessagesInbox from "./inbox/MessagesInbox.vue";
import { messagesServed, useMessagesBadges } from "../../../models/messages/useMessages";

// MESSAGES (docs/architecture/messages.md, "The editor"): what this sandbox exchanges with other sandboxes, in three parts
// drawn as underlined tabs, as Access's are. The Inbox is the threads, read and written where they are listed; Contacts
// the other sandboxes, the requests waiting on a person first, each with its key, what it may do here, and the ways to add
// one; Identity what other sandboxes know this one by. The part lives in the query (`?section=`), the Inbox writing none,
// and a thread open in the Inbox, or a contact open in Contacts, is `?open=`, so a link lands on it. Identity is a
// maintainer's, as the daemon floors it.

const { open = undefined } = defineProps<{
    // A thread or a contact a link names (`?open=<id>`), handed down by the hub so a reload lands on it.
    open?: string;
}>();

const t = useT();
const route = useRoute();
const router = useRouter();
const { canShip } = useTier();

const parts = computed<readonly MessagesPart[]>(() => (canShip.value ? MESSAGES_PARTS : MESSAGES_PARTS.filter((part) => part !== `identity`)));
const first = computed<MessagesPart>(() => parts.value[0] ?? `inbox`);

// The Inbox carries the threads with something unread, Contacts the requests and the tasks waiting: what waits is seen
// from either.
const badges = useMessagesBadges();
const LABELS = computed<Record<MessagesPart, string>>(() => ({
    inbox: t(`sandbox.messages.parts.inbox`),
    contacts: t(`sandbox.messages.parts.contacts`),
    identity: t(`sandbox.messages.parts.identity`),
}));
const COUNTS = computed<Partial<Record<MessagesPart, number>>>(() => ({ inbox: badges.inbox.value, contacts: badges.contacts.value }));
const options = computed(() => parts.value.map((value) => ({ label: LABELS.value[value], value, badge: COUNTS.value[value] ?? 0 })));

// Pushed, not replaced, so Back returns to the part before; a thread open in the Inbox is left behind with it.
const part = computed<MessagesPart>({
    get: () => parts.value.find((entry) => entry === route.query[`section`]) ?? first.value,
    set: (value) => void router.push({ query: { ...route.query, section: value === first.value ? undefined : value, open: undefined } }),
});
</script>

<template>
    <!-- `@container`: the Inbox lays its list beside the open thread only when this pane has the room. -->
    <div class="@container flex flex-col gap-6">
        <RowNote v-if="!messagesServed()" variant="empty">{{ t(`sandbox.messages.tooOld`) }}</RowNote>
        <template v-else>
            <SegmentedControl v-model="part" :options="options" variant="underline" :aria-label="t(`sandbox.messages.partsLabel`)" />
            <MessagesInbox v-if="part === `inbox`" :open="open" />
            <MessagesContacts v-else-if="part === `contacts`" :open="open" />
            <MessagesIdentity v-else />
        </template>
    </div>
</template>
