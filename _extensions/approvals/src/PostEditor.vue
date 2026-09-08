<!--
    In-place editor that replaces <PostBody> at the same size and position, so editing does not shift the row. Uses <ProseField>, not a bordered
    textarea: no border until focused, grows against a hidden replica. No Save or Cancel — every keystroke writes the file directly (usePostEdit.ts);
    Escape closes without discarding.
-->
<script setup lang="ts">
import type { PostApprovalSummary } from "@intentic/sandbox-contract";
import { ProseField } from "@intentic/extension-ui";
import { type ComponentPublicInstance, computed, onBeforeUnmount } from "vue";
import { postsATitle } from "./postText";

const { post } = defineProps<{ post: PostApprovalSummary }>();
const emit = defineEmits<{ close: []; touch: [] }>();

const content = defineModel<string>(`content`, { required: true });
const title = defineModel<string>(`title`, { required: true });

// A headline box only where the platform publishes one. Everywhere else `title` is the agent's note about the
// post (postText.ts): it is shown under the post, and editing the post has no business rewriting it.
const headlined = computed(() => postsATitle(post.platform, post.target));

/* The field exists only after the click, so `autofocus` (an initial-page-load attribute) would never fire.
 * The caret goes to the end rather than selecting everything: this is a change to a post, not a replacement of
 * it, and a stray keystroke over a full selection would wipe one. */
const caretAtEnd = (el: Element | ComponentPublicInstance | null): void => {
    const field = (el as { field?: HTMLTextAreaElement } | null)?.field;
    if (field !== undefined) {
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
    }
};

// The row disappearing out from under an open editor (approved, rejected, refetched away) must not be what
// loses the last sentence someone typed.
onBeforeUnmount(() => emit(`touch`));
</script>

<template>
    <div class="-mx-2 -my-1 max-w-read">
        <ProseField
            v-if="headlined"
            v-model="title"
            variant="heading"
            aria-label="Post title"
            @input="emit(`touch`)"
            @keydown.escape="emit(`close`)"
        />
        <ProseField
            :ref="headlined ? undefined : caretAtEnd"
            v-model="content"
            variant="post"
            aria-label="Post text"
            @input="emit(`touch`)"
            @keydown.escape="emit(`close`)"
        />
    </div>
</template>
