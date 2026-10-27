<!-- The post's words under the caret, at <PostBody>'s size and position, so starting to write moves nothing (PostText.vue). -->
<script setup lang="ts">
import type { PostApprovalSummary } from "@intentic/sandbox-contract/schemas/approvals";
import { ProseField } from "@intentic/extension-ui";
import { type ComponentPublicInstance, computed, onBeforeUnmount } from "vue";
import { postsATitle } from "./postText";
import { t } from "./i18n.js";

const { post } = defineProps<{ post: PostApprovalSummary }>();
const emit = defineEmits<{ close: []; touch: [] }>();

const content = defineModel<string>("content", { required: true });
const title = defineModel<string>("title", { required: true });

// A headline box only where the platform publishes one. Everywhere else `title` is the agent's note about the
// post (postText.ts): it is shown under the post, and editing the post has no business rewriting it.
const headlined = computed(() => postsATitle(post.platform, post.target));

/* The field exists only after the press, so `autofocus` (an initial-page-load attribute) would never fire. The caret goes to
   the end of the post's words, headline or not: they are what a press on the post asked to change. */
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
            :aria-label="t(`postEditor.postTitle`)"
            @input="emit(`touch`)"
            @keydown.escape="emit(`close`)"
        />
        <ProseField
            :ref="caretAtEnd"
            v-model="content"
            variant="post"
            :aria-label="t(`postEditor.postText`)"
            @input="emit(`touch`)"
            @keydown.escape="emit(`close`)"
        />
    </div>
</template>
