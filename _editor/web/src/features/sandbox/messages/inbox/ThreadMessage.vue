<script setup lang="ts">
import type { S2sThreadMessage } from "@intentic/sandbox-contract/schemas/s2s";
import { tierAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import { Notice, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { formatBytes, formatClock } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, shallowRef } from "vue";
import { useTier } from "../../../../client/sandbox/useTier";
import { useMessagesApi } from "../../../../models/messages/messagesApi";
import { deliveryMark } from "../../../../models/messages/messagesView";
import TakeFiles from "./TakeFiles.vue";

// ONE MESSAGE in its thread: received ones on the reading edge, sent ones tinted on the far edge, the way a conversation is
// read. A run's first message names its sender; a report, a task or a contact's own message says what kind it is. The words
// are another sandbox's, drawn as plain text, never as markup. Files download one by one, and a received message's files
// can be copied into a folder of the workspace (a collaborator's, as the daemon floors the take). A sent message says how
// its delivery stands.

const props = defineProps<{
    message: S2sThreadMessage;
    contactName: string;
    sandboxName: string;
    /** It opens a run from its side, so its sender is named. */
    opens: boolean;
}>();

const t = useT();
const api = useMessagesApi();
const { tier } = useTier();

const out = computed(() => props.message.direction === `out`);
const sender = computed(() => (out.value ? props.sandboxName : props.contactName));
const at = computed(() => formatClock(props.message.receivedAt ?? props.message.sentAt));
// What else than a message it is, by the kind's family: a report, a task's traffic, a contact's own, a key change, a receipt.
const kindWord = computed((): string | undefined => {
    switch (props.message.kind.split(`.`)[0]) {
        case `report`:
            return t(`sandbox.messages.kinds.report`);
        case `task`:
            return t(`sandbox.messages.kinds.task`);
        case `contact`:
            return t(`sandbox.messages.kinds.contact`);
        case `identity`:
            return t(`sandbox.messages.kinds.identity`);
        case `receipt`:
            return t(`sandbox.messages.kinds.receipt`);
        default:
            return undefined;
    }
});

const mark = computed(() => deliveryMark(props.message));
const deliveryLine = computed((): string | undefined => {
    const delivery = props.message.delivery;
    switch (mark.value) {
        case `queued`:
            return [t(`sandbox.messages.delivery.queued`), ...(delivery && delivery.attempts > 0 ? [t(`sandbox.messages.delivery.attempts`, { count: delivery.attempts }, delivery.attempts)] : [])].join(` · `);
        case `undelivered`:
            return [t(`sandbox.messages.delivery.undelivered`), ...(delivery?.reason === undefined ? [] : [delivery.reason])].join(` · `);
        case `sent`:
            return t(`sandbox.messages.delivery.sent`);
        default:
            return undefined;
    }
});

// One file, read whole into the tab and saved under its own name; the object URL held a beat past the click.
const HOLD_MS = 10_000;
const fetching = ref<string>();
const notice = shallowRef<ReturnType<typeof noticeFrom>>();
const download = async (name: string): Promise<void> => {
    fetching.value = name;
    notice.value = undefined;
    try {
        const url = URL.createObjectURL(await api.file(props.message.id, name));
        const anchor = document.createElement(`a`);
        anchor.href = url;
        anchor.download = name;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), HOLD_MS);
    } catch (error) {
        notice.value = noticeFrom(error, t(`sandbox.messages.thread.downloadFailed`, { name }));
    } finally {
        fetching.value = undefined;
    }
};

const takes = computed(() => !out.value && props.message.attachments.length > 0 && tierAtLeast(tier.value, `collaborator`));
</script>

<template>
    <article class="flex max-w-[88%] flex-col gap-1" :class="out ? `ml-auto items-end` : `mr-auto items-start`" :data-message="message.id" :data-direction="message.direction">
        <p v-if="opens" class="flex items-baseline gap-1.5 px-1 text-2xs text-subtle">
            <span class="font-medium text-muted">{{ sender }}</span>
            <span v-if="message.as">{{ t(`sandbox.messages.thread.as`, { person: message.as }) }}</span>
            <span v-if="kindWord" class="rounded bg-overlay px-1 text-muted">{{ kindWord }}</span>
        </p>
        <div class="flex flex-col gap-2 rounded-2xl px-3.5 py-2.5" :class="out ? `rounded-br-md bg-primary-tint` : `rounded-bl-md border border-line-subtle bg-card`">
            <p v-if="message.subject" class="text-xs font-semibold text-content">{{ message.subject }}</p>
            <p v-if="message.text" class="whitespace-pre-wrap break-words text-sm leading-relaxed text-content">{{ message.text }}</p>
            <ul v-if="message.attachments.length > 0" class="flex flex-wrap gap-1.5">
                <li v-for="file in message.attachments" :key="file.name">
                    <button
                        type="button"
                        :class="ui.chip({ size: `sm` }, `max-w-64`)"
                        :disabled="fetching !== undefined"
                        :aria-label="t(`sandbox.messages.thread.download`, { name: file.name })"
                        data-attachment
                        @click="download(file.name)"
                    >
                        <Icon :name="fetching === file.name ? `spinner` : `paperclip`" class="size-3.5 shrink-0 text-muted" :class="fetching === file.name ? `animate-spin` : ``" />
                        <span class="truncate">{{ file.name }}</span>
                        <span class="shrink-0 tabular-nums text-subtle">{{ formatBytes(file.size) }}</span>
                    </button>
                </li>
            </ul>
            <TakeFiles v-if="takes" :message="message.id" :contact-name="contactName" />
        </div>
        <p class="flex items-center gap-1 px-1 text-2xs tabular-nums" :class="mark === `undelivered` ? `text-danger` : `text-subtle`" :data-delivery="mark">
            <Icon v-if="mark === `undelivered`" name="exclamation-triangle" class="size-3" />
            <Icon v-else-if="mark === `queued`" name="clock" class="size-3" />
            <Icon v-else-if="mark === `sent`" name="check" class="size-3" />
            <span>{{ at }}</span>
            <span v-if="deliveryLine">· {{ deliveryLine }}</span>
        </p>
        <Notice v-if="notice" :of="notice" />
    </article>
</template>
