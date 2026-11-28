<script setup lang="ts">
import { Avatar, Await, Button, ConfirmDialog, Notice, RowNote } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { formatDayHeading } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, shallowRef, watch } from "vue";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { identityHue } from "../../../../lib/identityHue";
import { useMessagesApi } from "../../../../models/messages/messagesApi";
import { hasUnread, threadDays } from "../../../../models/messages/messagesView";
import { threadsChanged, useContacts, useThread } from "../../../../models/messages/useMessages";
import MessageComposer from "./MessageComposer.vue";
import ThreadMessage from "./ThreadMessage.vue";

// ONE THREAD, read top to bottom: its contact and subject, then its messages in days, each run from one side naming its
// sender once, sent ones marked with how their delivery stands, received ones with their files to download or take into a
// folder. Opening it marks what was unread read. A reply goes into the thread from the composer at its foot, while the
// contact still takes messages; Delete takes the thread off this sandbox, after asking.

const props = defineProps<{ id: string }>();
const emit = defineEmits<{ closed: [] }>();

const t = useT();
const api = useMessagesApi();
const { active } = useSandbox();
const { query, loaded } = useThread(() => props.id);
const summary = computed(() => query.data.value?.thread);
const days = computed(() => threadDays(query.data.value?.messages ?? []));

// The contact it is with, for whether a reply can go: one that is no longer accepted takes nothing.
const { contacts } = useContacts();
const contact = computed(() => contacts.value.find((each) => each.id === summary.value?.contact));
const canReply = computed(() => contact.value?.state === `accepted`);

// Read once it has been seen, once per thread opened: a refetch while it stays open marks what arrived since.
watch(
    () => query.data.value,
    async (thread) => {
        if (thread === undefined || thread.thread.id !== props.id || !hasUnread(thread.messages)) {
            return;
        }
        try {
            await api.markRead(props.id);
            await threadsChanged();
            // allow(silent-catch): left unread, the next read of the thread tries again; nothing the reader asked for failed.
        } catch {
            return;
        }
    },
    { immediate: true },
);

const asking = ref(false);
const deleting = ref(false);
const notice = shallowRef<ReturnType<typeof noticeFrom>>();
const remove = async (): Promise<void> => {
    deleting.value = true;
    notice.value = undefined;
    try {
        await api.deleteThread(props.id);
        asking.value = false;
        await threadsChanged();
        emit(`closed`);
    } catch (error) {
        notice.value = noticeFrom(error, t(`sandbox.messages.thread.deleteFailed`));
    } finally {
        deleting.value = false;
    }
};
</script>

<template>
    <section class="flex flex-col gap-4" :data-open-thread="id">
        <!-- Who it is with and what about; Back only where the list is not beside it. -->
        <header class="flex items-center gap-3 border-b border-line-subtle pb-3">
            <Button class="@3xl:hidden" :label="t(`sandbox.messages.thread.back`)" size="small" tier="quiet" @click="emit(`closed`)">
                <template #icon><Icon name="arrow-left" /></template>
            </Button>
            <template v-if="summary">
                <Avatar :size="32" :name="summary.contactName" :hue="identityHue(summary.contact)" />
                <div class="min-w-0 flex-1">
                    <h3 class="truncate text-sm font-semibold text-content">{{ summary.contactName }}</h3>
                    <p class="truncate text-xs text-muted">
                        {{ summary.subject ?? t(`sandbox.messages.thread.noSubject`) }}
                        <template v-if="summary.scope.kind === `person`"> · {{ t(`sandbox.messages.inbox.forPerson`, { person: summary.scope.person }) }}</template>
                    </p>
                </div>
                <Button :label="t(`sandbox.messages.thread.delete`)" size="small" tier="quiet" tone="danger" @click="asking = true">
                    <template #icon><Icon name="trash" /></template>
                </Button>
            </template>
        </header>
        <Notice v-if="notice" :of="notice" />

        <Await :of="loaded">
            <div class="flex flex-col gap-5">
                <div v-for="day in days" :key="day.day" class="flex flex-col gap-1.5">
                    <p class="py-1 text-center text-2xs font-medium text-subtle">{{ formatDayHeading(day.day) }}</p>
                    <ThreadMessage
                        v-for="(message, at) in day.messages"
                        :key="message.id"
                        :message="message"
                        :contact-name="summary?.contactName ?? ``"
                        :sandbox-name="active?.name ?? ``"
                        :opens="day.opens[at] ?? true"
                    />
                </div>
            </div>
        </Await>

        <MessageComposer v-if="summary && canReply" :to="summary.contact" :thread="id" :contact-name="summary.contactName" />
        <RowNote v-else-if="summary && contact !== undefined" icon="lock" tone="warning">
            {{ t(`sandbox.messages.thread.cantReply`, { name: summary.contactName }) }}
        </RowNote>

        <ConfirmDialog
            :open="asking"
            :header="t(`sandbox.messages.thread.deleteAsk`)"
            :description="t(`sandbox.messages.thread.deleteWhat`)"
            :confirm-label="t(`sandbox.messages.thread.delete`)"
            confirm-icon="trash"
            destructive
            :loading="deleting"
            @confirm="remove"
            @cancel="asking = false"
        />
    </section>
</template>
