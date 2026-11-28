<script setup lang="ts">
import type { S2sContact, S2sContactNotice, S2sContactTask, S2sGrantsUpdate } from "@intentic/sandbox-contract/schemas/s2s";
import { Avatar, Button, ConfirmDialog, DisclosureRow, Notice, RowNote, StatusBadge } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { formatDate, timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { type ComponentPublicInstance, computed, nextTick, onMounted, ref, shallowRef, useTemplateRef, watch } from "vue";
import { identityHue } from "../../../../lib/identityHue";
import Fingerprint from "../../../../parts/messages/Fingerprint.vue";
import { grantsLine } from "../../../../models/messages/grantWords";
import { useMessagesApi } from "../../../../models/messages/messagesApi";
import { noticeTone, unseenNotices, withGrants } from "../../../../models/messages/messagesView";
import { contactsChanged } from "../../../../models/messages/useMessages";
import ContactTasks from "./ContactTasks.vue";
import GrantsEditor from "./GrantsEditor.vue";

// ONE CONTACT: its name and address, whom it speaks for, and what it may do here, on one line. What is true of it now
// stands under the row without opening it: a key that changed with no proof (held both ways until a person compares the
// new fingerprint and trusts it) and the notices not yet read (a rotation, a recovery, a key vouched for only by DNS, a
// move, a removal). Opened, it shows the key pinned for it, what it lets this sandbox do there, and its grants, each
// changed where it is shown, and the tasks it handed this sandbox; Remove ends it after asking. A link naming it
// (`?open=<contact>`, as the push saying one of its tasks waits does) opens it and brings it into view.

const props = defineProps<{
    contact: S2sContact;
    /** The reader may change its grants and remove it: a maintainer, as the daemon floors both. */
    manages: boolean;
    /** The tasks it handed this sandbox, in the order they are read (messagesView.ts `tasksOfContact`). */
    tasks?: readonly S2sContactTask[];
    /** A link named it: it opens, and scrolls into view, once it is drawn. */
    opened?: boolean;
}>();

const t = useT();
const api = useMessagesApi();
const open = ref(false);
const row = useTemplateRef<ComponentPublicInstance>(`row`);
const reveal = async (): Promise<void> => {
    if (props.opened !== true) {
        return;
    }
    open.value = true;
    await nextTick();
    const element: unknown = row.value?.$el;
    if (element instanceof HTMLElement) {
        element.scrollIntoView({ block: `start`, behavior: `smooth` });
    }
};
onMounted(() => void reveal());
watch(() => props.opened, () => void reveal());
const tasks = computed(() => props.tasks ?? []);
const waiting = computed(() => tasks.value.filter((task) => task.state === `held`).length);

// The row as the last write left it, until the list is read again.
const shown = shallowRef<S2sContact>();
watch(
    () => props.contact,
    () => {
        shown.value = undefined;
    },
);
const contact = computed(() => shown.value ?? props.contact);

const scopeWord = computed(() =>
    contact.value.scope.kind === `person` ? t(`sandbox.messages.contacts.forPerson`, { person: contact.value.scope.person }) : t(`sandbox.messages.contacts.asSandbox`),
);
const description = computed(() => [contact.value.address, scopeWord.value, t(`sandbox.messages.contacts.may`, { grants: grantsLine(contact.value.grants) })].join(` · `));

const STATES = {
    "pending-out": { variant: `info`, label: () => t(`sandbox.messages.contacts.state.pendingOut`) },
    "key-changed": { variant: `danger`, label: () => t(`sandbox.messages.contacts.state.keyChanged`) },
} as const;
const state = computed(() => (contact.value.state === `pending-out` || contact.value.state === `key-changed` ? STATES[contact.value.state] : undefined));

const noticeText = (notice: S2sContactNotice): string => {
    const date = formatDate(notice.at);
    switch (notice.kind) {
        case `rotated`:
            return t(`sandbox.messages.notices.rotated`, { date });
        case `recovered`:
            return t(`sandbox.messages.notices.recovered`, { date });
        case `rekeyed-by-domain`:
            return t(`sandbox.messages.notices.rekeyedByDomain`, { date });
        case `moved`:
            return t(`sandbox.messages.notices.moved`, { date, from: notice.from ?? ``, to: notice.to ?? `` });
        case `removed`:
            return t(`sandbox.messages.notices.removed`, { date });
    }
};
const notices = computed(() => unseenNotices(contact.value));

const busy = ref(false);
const notice = shallowRef<ReturnType<typeof noticeFrom>>();
const write = async (task: () => Promise<S2sContact | undefined>, failed: string): Promise<boolean> => {
    busy.value = true;
    notice.value = undefined;
    try {
        const answered = await task();
        if (answered !== undefined) {
            shown.value = answered;
        }
        await contactsChanged();
        return true;
    } catch (error) {
        notice.value = noticeFrom(error, failed);
        return false;
    } finally {
        busy.value = false;
    }
};

// A grant changed is shown at once and written as the one field it changed; a refusal puts the row back as the daemon has it.
const changeGrants = async (change: S2sGrantsUpdate): Promise<void> => {
    const before = shown.value;
    shown.value = { ...contact.value, grants: withGrants(contact.value.grants, change) };
    const ok = await write(() => api.changeContact(contact.value.id, { grants: change }), t(`sandbox.messages.contacts.saveFailed`));
    if (!ok) {
        shown.value = before;
    }
};

const trusting = ref(false);
const trust = async (): Promise<void> => {
    const fingerprint = contact.value.pendingKey;
    if (fingerprint !== undefined && (await write(() => api.trustKey(contact.value.id, fingerprint), t(`sandbox.messages.contacts.trustFailed`)))) {
        trusting.value = false;
    }
};

const removing = ref(false);
const remove = async (): Promise<void> => {
    if (await write(async () => {
        await api.removeContact(contact.value.id);
        return undefined;
    }, t(`sandbox.messages.contacts.removeFailed`))) {
        removing.value = false;
    }
};
</script>

<template>
    <DisclosureRow ref="row" v-model:open="open" lead="face" body="drawer" :title="contact.name" :description="description" :data-contact="contact.id">
        <template #lead="{ mark }">
            <Avatar :size="mark" :name="contact.name" :hue="identityHue(contact.id)" />
        </template>
        <template #meta>
            <StatusBadge v-if="state" :variant="state.variant" :label="state.label()" size="xs" />
            <StatusBadge v-if="waiting > 0" variant="warning" :label="t(`sandbox.messages.tasks.waitingOn`, { count: waiting }, waiting)" size="xs" />
            <span v-if="contact.lastSeenAt">{{ t(`sandbox.messages.contacts.heard`, { ago: timeAgo(contact.lastSeenAt, { days: true }) }) }}</span>
        </template>
        <template #below>
            <div class="flex flex-col gap-4">
                <div class="flex flex-col gap-1">
                    <span class="text-2xs text-subtle">{{ t(`sandbox.messages.contacts.pinnedKey`) }}</span>
                    <Fingerprint :fingerprint="contact.fingerprint" />
                </div>
                <p v-if="contact.theirGrants" class="text-xs text-muted">{{ t(`sandbox.messages.contacts.theyLet`, { grants: grantsLine(contact.theirGrants) }) }}</p>
                <ContactTasks v-if="tasks.length > 0" :tasks="tasks" :manages="manages" />
                <div class="flex flex-col gap-1.5">
                    <span class="text-2xs text-subtle">{{ t(`sandbox.messages.contacts.mayHere`) }}</span>
                    <GrantsEditor :grants="contact.grants" :personal="contact.scope.kind === `person`" :disabled="!manages || busy" @change="changeGrants" />
                </div>
                <div v-if="manages || contact.scope.kind === `person`" class="flex justify-end">
                    <Button :label="t(`sandbox.messages.contacts.remove`)" size="small" tier="quiet" tone="danger" :disabled="busy" @click="removing = true" />
                </div>
            </div>
        </template>
    </DisclosureRow>

    <!-- What is true of it now, without opening it: a held key first, then what changed that nobody has read yet. -->
    <RowNote v-if="contact.state === `key-changed`" icon="exclamation-triangle" tone="danger" data-key-changed>
        <div class="flex flex-col gap-2">
            <span>{{ t(`sandbox.messages.contacts.keyChanged`, { name: contact.name }) }}</span>
            <div v-if="contact.pendingKey" class="flex flex-col gap-1">
                <span class="text-2xs text-subtle">{{ t(`sandbox.messages.contacts.newKey`) }}</span>
                <Fingerprint :fingerprint="contact.pendingKey" />
            </div>
            <div>
                <Button tier="accent" tone="danger" size="small" :label="t(`sandbox.messages.contacts.trustKey`)" :disabled="busy || !contact.pendingKey" @click="trusting = true">
                    <template #icon><Icon name="key" /></template>
                </Button>
            </div>
        </div>
    </RowNote>
    <RowNote v-for="each in notices" :key="`${each.kind}-${each.at}`" :icon="noticeTone(each) === `warning` ? `exclamation-triangle` : `key`" :tone="noticeTone(each) === `warning` ? `warning` : `default`" :data-notice="each.kind">
        {{ noticeText(each) }}
    </RowNote>
    <RowNote v-if="notice" variant="block"><Notice :of="notice" /></RowNote>

    <ConfirmDialog
        :open="trusting"
        :header="t(`sandbox.messages.contacts.trustAsk`, { name: contact.name })"
        :description="t(`sandbox.messages.contacts.trustWhat`)"
        :confirm-label="t(`sandbox.messages.contacts.trustKey`)"
        confirm-icon="key"
        tone="warning"
        :loading="busy"
        @confirm="trust"
        @cancel="trusting = false"
    >
        <Fingerprint v-if="contact.pendingKey" :fingerprint="contact.pendingKey" size="lg" :copy="false" />
    </ConfirmDialog>
    <ConfirmDialog
        :open="removing"
        :header="t(`sandbox.messages.contacts.removeAsk`, { name: contact.name })"
        :description="t(`sandbox.messages.contacts.removeWhat`)"
        :confirm-label="t(`sandbox.messages.contacts.remove`)"
        confirm-icon="trash"
        destructive
        :loading="busy"
        @confirm="remove"
        @cancel="removing = false"
    />
</template>
