<script setup lang="ts">
import type { S2sThreadSummary } from "@intentic/sandbox-contract/schemas/s2s";
import { Avatar, Await, Button, InfoHint, Row, RowGroup, RowNote } from "@intentic/ui";
import { countBadgePlate, countBadgeText } from "@intentic/ui/count-badge";
import { formatClock, formatWhen, timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useTier } from "../../../../client/sandbox/useTier";
import { identityHue } from "../../../../lib/identityHue";
import { outboxLine, threadsInOrder } from "../../../../models/messages/messagesView";
import { useOutbox, useThreads } from "../../../../models/messages/useMessages";
import MessageComposer from "./MessageComposer.vue";
import ThreadView from "./ThreadView.vue";

// MESSAGES ▸ INBOX: the threads the daemon shows the reader, newest first, each by its contact, what it is about and when
// it last moved, with what is unread in bold and what was not delivered marked. One opens beside the list where the pane
// has room, in its place where it has not (`?open=<thread>`, so a link lands on it and Back closes it). New message opens
// a composer in the same place, addressed to an accepted contact. What waits in the outbox is said once, above the list,
// to a maintainer, whom the daemon answers it to.

const { open = undefined } = defineProps<{
    // The thread a link names (`?open=<thread>`), handed down by the hub so a reload lands on it.
    open?: string;
}>();

const t = useT();
const route = useRoute();
const router = useRouter();
const { canShip } = useTier();

const { threads, loaded } = useThreads();
const ordered = computed(() => threadsInOrder(threads.value));

const composing = ref(false);
const openThread = (id: string | undefined): void => {
    composing.value = false;
    if (id !== open) {
        void router.push({ query: { ...route.query, open: id } });
    }
};
const startNew = (): void => {
    openThread(undefined);
    composing.value = true;
};
// A thread started from the composer opens as itself once the outbox took the first message.
const started = (thread: string): void => openThread(thread);
// Another part picked, or the thread closed by Back: no draft stays open over the list.
watch(
    () => open,
    (id) => {
        if (id !== undefined) {
            composing.value = false;
        }
    },
);
const detailOpen = computed(() => open !== undefined || composing.value);

// The outbox's one line: how many wait and why the oldest does, when the next try is, and how many could not be delivered.
const outbox = useOutbox(canShip);
const waiting = computed(() => outboxLine(outbox.value));
const outboxText = computed(() => {
    const line = waiting.value;
    if (line === undefined) {
        return undefined;
    }
    return [
        ...(line.waiting > 0 ? [t(`sandbox.messages.inbox.outboxWaiting`, { count: line.waiting }, line.waiting)] : []),
        ...(line.reason === undefined ? [] : [t(`sandbox.messages.inbox.outboxReason`, { reason: line.reason })]),
        ...(line.next === undefined ? [] : [t(`sandbox.messages.inbox.outboxNext`, { when: nextTry(line.next) })]),
        ...(line.undelivered > 0 ? [t(`sandbox.messages.inbox.outboxUndelivered`, { count: line.undelivered }, line.undelivered)] : []),
    ].join(` · `);
});

// The next try by the clock while it is today's, by the weekday past that.
const SAME_DAY_MS = 12 * 3_600_000;
const nextTry = (at: number): string => (at - Date.now() < SAME_DAY_MS ? formatClock(at) : formatWhen(at));

// A thread's second line: its subject, else the last thing said in it, with who said it when it was this sandbox.
const lineOf = (thread: S2sThreadSummary): string => {
    const said = thread.last.direction === `out` ? t(`sandbox.messages.inbox.youSaid`, { text: thread.last.preview }) : thread.last.preview;
    return thread.subject === undefined ? said : `${thread.subject} · ${said}`;
};
const whenOf = (thread: S2sThreadSummary): string => timeAgo(thread.last.at, { days: true });
</script>

<template>
    <div class="flex flex-col gap-4 @3xl:flex-row @3xl:items-start">
        <!-- The list: beside the open thread with room, in its place without. -->
        <div class="min-w-0 flex-col gap-4 @3xl:flex @3xl:w-80 @3xl:shrink-0" :class="detailOpen ? `hidden` : `flex`">
            <RowGroup :label="t(`sandbox.messages.inbox.threads`)">
                <template #info>
                    <InfoHint :label="t(`sandbox.messages.inbox.about`)">
                        <span class="block text-xs text-content">{{ t(`sandbox.messages.inbox.aboutBody`) }}</span>
                    </InfoHint>
                </template>
                <template #actions>
                    <Button :label="t(`sandbox.messages.inbox.newMessage`)" size="small" tier="boring" @click="startNew">
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>
                <RowNote v-if="outboxText" icon="clock" data-outbox>{{ outboxText }}</RowNote>
                <Await :of="loaded">
                    <Row
                        v-for="thread in ordered"
                        :key="thread.id"
                        as="button"
                        lead="face"
                        interactive
                        :selected="thread.id === open"
                        :title="thread.contactName"
                        :description="lineOf(thread)"
                        :data-thread="thread.id"
                        @click="openThread(thread.id)"
                    >
                        <template v-if="thread.unread > 0" #title><span class="font-semibold">{{ thread.contactName }}</span></template>
                        <template #lead="{ mark }">
                            <Avatar :size="mark" :name="thread.contactName" :hue="identityHue(thread.contact)" />
                        </template>
                        <template #meta>
                            <span class="flex shrink-0 items-center gap-1.5 text-2xs text-subtle">
                                <span v-if="thread.undelivered > 0" class="text-danger">{{ t(`sandbox.messages.inbox.undelivered`, { count: thread.undelivered }, thread.undelivered) }}</span>
                                <span>{{ whenOf(thread) }}</span>
                                <span
                                    v-if="thread.unread > 0"
                                    class="inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-3xs font-semibold tabular-nums"
                                    :class="countBadgePlate()"
                                    :aria-label="t(`sandbox.messages.inbox.unread`, { count: thread.unread }, thread.unread)"
                                    >{{ countBadgeText(thread.unread) }}</span
                                >
                            </span>
                        </template>
                    </Row>
                    <RowNote v-if="ordered.length === 0" variant="empty">{{ t(`sandbox.messages.inbox.empty`) }}</RowNote>
                </Await>
            </RowGroup>
        </div>

        <!-- The open thread, or a new message being written; with room and nothing open, where to start. -->
        <div class="min-w-0 flex-1" :class="detailOpen ? `` : `hidden @3xl:block`">
            <MessageComposer v-if="composing" @started="started" @cancel="composing = false" />
            <ThreadView v-else-if="open" :id="open" @closed="openThread(undefined)" />
            <RowNote v-else variant="empty">{{ t(`sandbox.messages.inbox.pickOne`) }}</RowNote>
        </div>
    </div>
</template>
