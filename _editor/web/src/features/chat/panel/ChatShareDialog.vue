<!-- Confirms sharing a conversation, which is irreversible once opened. -->
<script setup lang="ts">
import { Button, ui, CopyButton, Icon, Modal, Notice } from "@intentic/ui";
import type { ShareDetail, SharedConversation } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const props = defineProps<{ visible: boolean; conversationId: string; title: string }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "shared"): void }>();

const name = ref(``);
const detail = ref<ShareDetail>(`messages`);
const busy = ref(false);
const error = ref<string>();
const result = ref<SharedConversation>();

// Opening seeds the field with the chat's own name and clears whatever the last share left behind: the
// dialog is reused across conversations, and a link from the previous one still on screen would be read as
// this one's.
watch(
    () => props.visible,
    (visible) => {
        if (visible) {
            name.value = props.title;
            detail.value = `messages`;
            error.value = undefined;
            result.value = undefined;
        }
    },
    { immediate: true },
);

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
    // A share already in the air owns this dialog. The button holds itself once pressed, but Enter in the name
    // field submits the form directly, and a second Enter used to publish the conversation twice.
    if (busy.value) {
        return;
    }
    busy.value = true;
    error.value = undefined;
    try {
        result.value = await sandboxRpc.share.create({ conversationId: props.conversationId, title: name.value.trim(), detail: detail.value });
        emit(`shared`);
    } catch (caught) {
        error.value = caught instanceof Error ? caught.message : `The conversation could not be shared.`;
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <Modal :open="visible" size="md" :header="t(`chat.chatShareDialog.shareConversation`)" @update:open="emit(`update:visible`, $event)">
        <!-- After: the link, and nothing to decide. -->
        <div v-if="result" class="flex flex-col gap-3">
            <p class="text-xs text-muted">{{ t(`chat.chatShareDialog.anyoneLinkReadConversation`) }}</p>
            <div class="flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2">
                <Icon name="globe" class="shrink-0 text-subtle" />
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted" :title="result.url">{{
                    result.url ?? t(`chat.chatShareDialog.noPublicAddress`)
                }}</span>
                <a
                    v-if="result.url"
                    :href="result.url"
                    target="_blank"
                    rel="noopener"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-subtle hover:bg-overlay hover:text-content"
                    :aria-label="t(`chat.chatShareDialog.openSharedConversationIn`)"
                    v-tooltip.bottom="t(`ui.action.openInNewTab`)"
                >
                    <Icon name="external-link" class="text-2xs" />
                </a>
            </div>
            <p class="text-2xs text-subtle">{{ t(`chat.chatShareDialog.updateStopSharingAny`) }}</p>
        </div>

        <!-- Before: the two decisions. -->
        <form v-else class="flex flex-col gap-4" @submit.prevent="name.trim() && share()">
            <Notice v-if="error" tone="danger">{{ error }}</Notice>

            <label class="ui-field">
                <span class="ui-field-label">{{ t(`chat.chatShareDialog.title`) }}</span>
                <input v-model="name" autofocus maxlength="80" :class="ui.input()" />
                <span class="ui-field-hint">{{ t(`chat.chatShareDialog.shownAtTopPage`) }}</span>
            </label>

            <div class="flex flex-col gap-1.5">
                <span class="ui-field-label">{{ t(`chat.chatShareDialog.whatToInclude`) }}</span>
                <button
                    v-for="option in DETAILS"
                    :key="option.value"
                    type="button"
                    role="radio"
                    :aria-checked="detail === option.value"
                    class="ui-row-select flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left"
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
            <Button v-if="result" :label="t(`ui.action.done`)" size="small" @click="emit(`update:visible`, false)" />
            <template v-else>
                <Button :label="t(`ui.action.cancel`)" size="small" severity="secondary" text @click="emit(`update:visible`, false)" />
                <Button :label="t(`chat.chatShareDialog.share`)" size="small" :loading="busy" :disabled="name.trim().length === 0" @click="share" />
            </template>
            <CopyButton v-if="result?.url" :text="result.url" :label="t(`ui.action.copyLink`)" />
        </template>
    </Modal>
</template>
