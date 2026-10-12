<!-- Confirms sharing a conversation, which is irreversible once opened. -->
<script setup lang="ts">
import { Button, ui, CopyButton, Icon, Modal, Notice } from "@intentic/ui";
import type { ShareDetail, SharedConversation } from "@intentic/sandbox-contract";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { useOperation } from "../../../workbench/operations/operations";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const props = defineProps<{ visible: boolean; conversationId: string; title: string }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "shared"): void }>();

const name = ref(``);
const detail = ref<ShareDetail>(`messages`);

// Publishing a long chat takes seconds, and this dialog is gone the moment it closes. So the share is the
// conversation's rather than the dialog's: closed mid-way and opened again, the press is still held (a second one
// would publish a second link), and the link once made waits here until Done puts it away, since it is a link to pass
// on and the reader may have looked away to paste it somewhere.
const sharing = useOperation<SharedConversation>(() => `chat/${props.conversationId}/share`);
const { busy, value: result, failure } = sharing;

// Opening seeds the field with the chat's own name. What an earlier share left behind is filed under its own
// conversation, so another chat's link is never read as this one's.
watch(
    () => props.visible,
    (visible) => {
        if (visible) {
            name.value = props.title;
            detail.value = `messages`;
        }
    },
    { immediate: true },
);

// A failure read here goes with the dialog, as it always did; only the link is worth keeping past it.
onBeforeUnmount(() => {
    if (sharing.operation.value?.state === `failed`) {
        sharing.dismiss();
    }
});

// What each answer actually publishes, said where the answer is made.
const DETAILS = computed((): readonly { readonly value: ShareDetail; readonly label: string; readonly note: string }[] => [
    { value: `messages`, label: t(`chat.chatShareDialog.messagesOnly`), note: t(`chat.chatShareDialog.promptsAgentsWrittenAnswers`) },
    {
        value: `everything`,
        label: t(`chat.chatShareDialog.everything`),
        note: t(`chat.chatShareDialog.addsWorkAgentDid`),
    },
]);

const share = async (): Promise<void> => {
    // Enter in the name field submits the form directly, past the held button; a share already in the air refuses a
    // second start, where a second Enter used to publish the conversation twice.
    const conversationId = props.conversationId;
    const title = name.value.trim();
    const include = detail.value;
    const ended = await sharing.run({
        what: t(`chat.chatShareDialog.sharing`, { title }),
        failed: t(`chat.chatShareDialog.couldNotShare`),
        keep: true,
        task: () => sandboxRpc.share.create({ conversationId, title, detail: include }),
    });
    if (ended?.state === `done`) {
        emit(`shared`);
    }
};

const done = (): void => {
    sharing.dismiss();
    emit(`update:visible`, false);
};
</script>

<template>
    <Modal
        :open="visible"
        size="md"
        :header="t(`chat.chatShareDialog.shareConversation`)"
        :description="result ? t(`chat.chatShareDialog.anyoneLinkReadConversation`) : undefined"
        @update:open="emit(`update:visible`, $event)"
    >
        <!-- After: the link, and nothing to decide. -->
        <div v-if="result" class="flex flex-col gap-3">
            <div class="flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2">
                <Icon name="globe" class="shrink-0 text-subtle" />
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted" v-tooltip.bottom.overflow="result.url">{{
                    result.url ?? t(`chat.chatShareDialog.noPublicAddress`)
                }}</span>
                <a
                    v-if="result.url"
                    :href="result.url"
                    target="_blank"
                    rel="noopener"
                    class="touch-target flex h-6 w-6 shrink-0 items-center justify-center rounded text-subtle hover:bg-overlay hover:text-content"
                    :aria-label="t(`chat.chatShareDialog.openSharedConversationIn`)"
                    v-tooltip.bottom="t(`ui.action.newTab`)"
                >
                    <Icon name="external-link" class="text-2xs" />
                </a>
            </div>
            <p class="text-2xs text-subtle">{{ t(`chat.chatShareDialog.updateStopSharingAny`) }}</p>
        </div>

        <!-- Before: the two decisions. -->
        <form v-else class="flex flex-col gap-4" @submit.prevent="name.trim() && share()">
            <Notice v-if="failure" :of="failure" />

            <label class="ui-field">
                <span class="ui-field-label">{{ t(`chat.chatShareDialog.title`) }}</span>
                <input v-model="name" autofocus maxlength="80" :class="ui.input()" />
                <span class="ui-field-hint">{{ t(`chat.chatShareDialog.shownAtTopPage`) }}</span>
            </label>

            <!-- The choices are rows on the dialog's ground, not boxed tiles: the pick is the tint, and the rows reach out by their
                 own padding so their marks line up with the label above. -->
            <div class="flex flex-col gap-1">
                <span class="ui-field-label">{{ t(`chat.chatShareDialog.whatToInclude`) }}</span>
                <button
                    v-for="option in DETAILS"
                    :key="option.value"
                    type="button"
                    role="radio"
                    :aria-checked="detail === option.value"
                    class="ui-row-select -mx-2.5 flex items-start gap-2 rounded-lg px-2.5 py-2 text-left"
                    :class="{ 'ui-row-select-on': detail === option.value }"
                    @click="detail = option.value"
                >
                    <Icon
                        class="mt-0.5 text-2xs"
                        :name="detail === option.value ? 'check-circle' : 'circle'"
                        :class="detail === option.value ? 'text-primary-500' : 'text-subtle'"
                    />
                    <span class="flex min-w-0 flex-col gap-0.5">
                        <span class="text-xs font-medium text-content">{{ option.label }}</span>
                        <span class="text-2xs leading-snug text-muted">{{ option.note }}</span>
                    </span>
                </button>
            </div>

            <!-- Sharing makes the conversation readable without sign-in. -->
            <p class="flex items-start gap-1.5 text-2xs text-warning">
                <Icon name="globe" class="mt-0.5 shrink-0 text-2xs" />
                <span>{{ t(`chat.chatShareDialog.anyoneLinkReadNo`) }}</span>
            </p>
        </form>

        <template #footer>
            <CopyButton v-if="result?.url" :text="result.url" :label="t(`ui.action.copyLink`)" class="mr-auto" />
            <Button v-if="result" :label="t(`ui.action.done`)" @click="done" />
            <template v-else>
                <Button :label="t(`ui.action.cancel`)" tier="quiet" @click="emit(`update:visible`, false)" />
                <Button :label="t(`chat.chatShareDialog.share`)" :loading="busy" :disabled="name.trim().length === 0" @click="share" />
            </template>
        </template>
    </Modal>
</template>
