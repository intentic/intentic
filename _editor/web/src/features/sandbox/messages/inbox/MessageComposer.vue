<script setup lang="ts">
import { Button, Notice, type NoticeModel, Picker, type PickerOption, RowNote, ui } from "@intentic/ui";
import { formatBytes } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, useTemplateRef } from "vue";
import { RouterLink } from "vue-router";
import { messagesPath } from "../../../../models/sandbox/sandboxNav";
import { messageable } from "../../../../models/messages/messagesView";
import { useContacts } from "../../../../models/messages/useMessages";
import { useComposer } from "./useComposer";

// WRITING A MESSAGE: at a thread's foot, a reply into it; from New message, a first message to an accepted contact, with
// a subject if it wants one. Words, files or both; Send, or Ctrl/⌘+Enter, files it in the outbox and answers at once, so
// the message appears in its thread marked as waiting until the far side takes it.

const props = defineProps<{
    /** The contact a reply goes to; absent, the reader picks one. */
    to?: string;
    /** The thread a reply continues. */
    thread?: string;
    /** The contact's name, for the reply's placeholder. */
    contactName?: string;
}>();
const emit = defineEmits<{ started: [thread: string]; cancel: [] }>();

const t = useT();
const fresh = computed(() => props.thread === undefined);

const { contacts } = useContacts();
const reachable = computed(() => messageable(contacts.value));
const options = computed<readonly PickerOption<string>[]>(() =>
    reachable.value.map((contact) => ({ value: contact.id, label: contact.name, description: contact.address })),
);
const picked = ref<string>();
const target = computed(() => ({ to: props.to ?? picked.value, thread: props.thread }));

const { text, subject, files, sending, result, failure, problem, ready, addFiles, removeFile, send } = useComposer(target);

const picker = useTemplateRef<HTMLInputElement>(`picker`);
const pick = (event: Event): void => {
    const input = event.target instanceof HTMLInputElement ? event.target : undefined;
    addFiles([...(input?.files ?? [])]);
    if (input !== undefined) {
        input.value = ``;
    }
};

const submit = async (): Promise<void> => {
    const ended = await send();
    if (ended?.state === `queued` && fresh.value) {
        emit(`started`, ended.thread);
    }
};

// What the send ended on, when it did not simply go: refused in words, or held for a person's yes.
const notice = computed((): NoticeModel | undefined => {
    if (failure.value !== undefined) {
        return { tone: `danger`, title: t(`sandbox.messages.composer.failed`), detail: failure.value };
    }
    if (problem.value !== undefined) {
        return { tone: `warning`, title: problem.value };
    }
    const ended = result.value;
    if (ended === undefined || ended.state === `queued`) {
        return undefined;
    }
    return ended.state === `refused`
        ? { tone: `danger`, title: t(`sandbox.messages.composer.refused`), detail: ended.reason }
        : { tone: `info`, title: t(`sandbox.messages.composer.asked`), detail: ended.reason };
});
</script>

<template>
    <RowNote v-if="fresh && reachable.length === 0" variant="empty">
        <div class="flex flex-col items-center gap-3">
            <span>{{ t(`sandbox.messages.composer.noContacts`) }}</span>
            <Button :as="RouterLink" :to="messagesPath(`contacts`)" tier="accent" size="small" :label="t(`sandbox.messages.composer.openContacts`)" />
        </div>
    </RowNote>
    <form v-else class="flex flex-col gap-2 rounded-xl border border-line-subtle bg-card p-3" data-composer @submit.prevent="submit">
        <template v-if="fresh">
            <div class="flex items-center gap-2">
                <span class="w-16 shrink-0 text-xs text-muted">{{ t(`sandbox.messages.composer.to`) }}</span>
                <Picker
                    v-model="picked"
                    :options="options"
                    variant="input"
                    :aria-label="t(`sandbox.messages.composer.to`)"
                    :header="t(`sandbox.messages.composer.to`)"
                    :placeholder="t(`sandbox.messages.composer.pickContact`)"
                    class="ui-field-sm min-w-0 flex-1"
                />
            </div>
            <div class="flex items-center gap-2">
                <span class="w-16 shrink-0 text-xs text-muted">{{ t(`sandbox.messages.composer.subject`) }}</span>
                <input v-model="subject" type="text" autocomplete="off" maxlength="200" :aria-label="t(`sandbox.messages.composer.subject`)" :class="ui.input({ size: `sm` }, `min-w-0 flex-1`)" />
            </div>
        </template>
        <textarea
            v-model="text"
            rows="3"
            :placeholder="fresh ? t(`sandbox.messages.composer.placeholder`) : t(`sandbox.messages.composer.replyTo`, { name: contactName ?? `` })"
            :aria-label="t(`sandbox.messages.composer.message`)"
            :class="ui.input({ size: `sm` }, `w-full resize-y leading-relaxed`)"
            @keydown.enter.meta.prevent="submit"
            @keydown.enter.ctrl.prevent="submit"
        />
        <ul v-if="files.length > 0" class="flex flex-wrap gap-1.5">
            <li v-for="file in files" :key="file.name" class="flex max-w-64 items-center gap-1.5 rounded-lg bg-overlay py-0.5 pl-2 pr-0.5 text-xs text-content">
                <Icon name="paperclip" class="size-3.5 shrink-0 text-muted" />
                <span class="truncate">{{ file.name }}</span>
                <span class="shrink-0 tabular-nums text-subtle">{{ formatBytes(file.size) }}</span>
                <button type="button" :class="ui.iconButton({ size: `xs` })" :aria-label="t(`sandbox.messages.composer.removeFile`, { name: file.name })" @click="removeFile(file.name)">
                    <Icon name="times" class="size-3" />
                </button>
            </li>
        </ul>
        <Notice v-if="notice" :of="notice" />
        <div class="flex items-center gap-2">
            <input ref="picker" type="file" multiple class="hidden" @change="pick" />
            <Button tier="quiet" size="small" :label="t(`sandbox.messages.composer.attach`)" @click="picker?.click()">
                <template #icon><Icon name="paperclip" /></template>
            </Button>
            <div class="ml-auto flex items-center gap-2">
                <Button v-if="fresh" tier="quiet" size="small" :label="t(`ui.action.cancel`)" :disabled="sending" @click="emit(`cancel`)" />
                <Button tier="accent" type="submit" size="small" :label="t(`sandbox.messages.composer.send`)" :loading="sending" :disabled="!ready || sending">
                    <template #icon><Icon name="send" /></template>
                </Button>
            </div>
        </div>
    </form>
</template>
