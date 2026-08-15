<!-- SHARE THIS CONVERSATION — the one screen between a private chat and a link anyone can open.
     Everything about it is shaped by that being irreversible in the way that matters: a link can be withdrawn,
     but not un-read. So the two decisions it asks for are the two that change what a stranger sees — what it is
     called, and how much of it travels — and both are stated in the words of what happens, not of what is
     configured. The consequence line changes with the choice rather than sitting under it as fine print,
     because "this publishes your code" is only true of one of the two answers and reads as noise on the other.

     It ends on the link itself. Sharing is a gesture with a result, and a dialog that closed on success would
     leave the user hunting for the thing they just made. -->
<script setup lang="ts">
import { ui, CopyButton, Icon, Modal, Notice } from "@intentic/ui";
import type { ShareDetail, SharedConversation } from "@intentic/sandbox-contract";
import Button from "primevue/button";
import { ref, watch } from "vue";
import { jsonBody } from "../composables/sandbox/jsonBody";
import { sandboxJson } from "../composables/sandbox/sandboxClient";

const props = defineProps<{ visible: boolean; conversationId: string; title: string }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "shared"): void }>();

const name = ref(``);
const detail = ref<ShareDetail>(`messages`);
const busy = ref(false);
const error = ref<string>();
const result = ref<SharedConversation>();

// Opening seeds the field with the chat's own name and clears whatever the last share left behind — the
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
const DETAILS: readonly { readonly value: ShareDetail; readonly label: string; readonly note: string }[] = [
    { value: `messages`, label: `Messages only`, note: `Your prompts and the agent's written answers.` },
    {
        value: `everything`,
        label: `Everything`,
        note: `Adds the work the agent did — the files it read and changed, what it ran, and its thinking. This publishes the code and command output that appear in those cards.`,
    },
];

const share = async (): Promise<void> => {
    busy.value = true;
    error.value = undefined;
    try {
        result.value = await sandboxJson<SharedConversation>(
            `/share`,
            jsonBody(`POST`, { conversationId: props.conversationId, title: name.value.trim(), detail: detail.value }),
        );
        emit(`shared`);
    } catch (caught) {
        error.value = caught instanceof Error ? caught.message : `The conversation could not be shared.`;
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <Modal
        :open="visible"
        size="md"
        header="Share this conversation"
        @update:open="emit(`update:visible`, $event)"
    >
        <!-- After: the link, and nothing to decide. -->
        <div v-if="result" class="flex flex-col gap-3">
            <p class="text-xs text-muted">Anyone with this link can read the conversation. It shows what was said up to now, and nothing after.</p>
            <div class="flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2">
                <Icon name="globe" class="shrink-0 text-subtle" />
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted" :title="result.url">{{ result.url ?? `No public address` }}</span>
                <a
                    v-if="result.url"
                    :href="result.url"
                    target="_blank"
                    rel="noopener"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-subtle hover:bg-overlay hover:text-content"
                    aria-label="Open the shared conversation in a new tab"
                    v-tooltip.bottom="'Open in new tab'"
                >
                    <Icon name="external-link" class="text-2xs" />
                </a>
            </div>
            <p class="text-2xs text-subtle">You can update or stop sharing it any time from Sandbox ▸ Public.</p>
        </div>

        <!-- Before: the two decisions. -->
        <form v-else class="flex flex-col gap-4" @submit.prevent="name.trim() && share()">
            <Notice v-if="error" tone="danger">{{ error }}</Notice>

            <label class="ui-field">
                <span class="ui-field-label">Title</span>
                <input v-model="name" autofocus maxlength="80" :class="ui.input()" />
                <span class="ui-field-hint">Shown at the top of the page, and used to name the link.</span>
            </label>

            <div class="flex flex-col gap-1.5">
                <span class="ui-field-label">What to include</span>
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

            <!-- The sentence that must not be missable, at the volume of a warning rather than a footnote:
                 this is the moment a private conversation stops being private. -->
            <p class="flex items-start gap-1.5 text-2xs text-warning">
                <Icon name="globe" class="mt-0.5 shrink-0 text-2xs" />
                <span>Anyone with the link can read it — no sign-in. Secrets are stripped, but nothing else is.</span>
            </p>
        </form>

        <template #footer>
            <Button v-if="result" label="Done" size="small" @click="emit(`update:visible`, false)" />
            <template v-else>
                <Button label="Cancel" size="small" severity="secondary" text @click="emit(`update:visible`, false)" />
                <Button label="Share" size="small" :loading="busy" :disabled="name.trim().length === 0" @click="share" />
            </template>
            <CopyButton v-if="result?.url" :text="result.url" label="Copy link" />
        </template>
    </Modal>
</template>
