<!-- THE POST, OPEN FOR CHANGES — and deliberately the same object it was a moment ago.

     IT REPLACES THE POST WITHOUT MOVING IT. Same measure, same size, same leading, same left edge as
     <DraftPost> beside it, so clicking the pencil does not redraw the row — the words stay exactly where your
     eye left them and simply become typeable. The first version put a bordered `cmp.input()` textarea here,
     which is the FORM field: a boxed control of a fixed height, right for a name or a shell command and wrong
     for the only thing on this page that is read in sentences. <ProseField> is the writing field — no border
     and no fill until the caret is in it, and it grows with the text through a hidden replica rather than a
     measure-and-set that the webfont swap would leave one line short.

     THE PADDING IS CANCELLED BY THE MARGIN, on both axes. ProseField insets its text so the focus fill has
     room to breathe; `-mx-2 -my-1` pulls exactly that inset back off the column, so the fill still bleeds
     around the words while the words themselves keep the pixel they occupied while being read — measured, not
     assumed: without the vertical half the first line dropped 4.4px, which is small, visible, and precisely
     what makes an in-place editor feel like a different screen.

     NO SAVE, NO CANCEL, and their absence is what fixed this row. They used to appear under the post while the
     row's own Approve and Reject disappeared, so one click on the pencil moved four controls at once. Typing
     writes the draft (useDraftEdit.ts) — the file is the post, unpublished until a separate decision, which is
     the same argument the acceptance panel makes for stories. Escape closes the editor; the last words are
     written on the way out, never dropped. -->
<script setup lang="ts">
import type { DraftSummary } from "@intentic/sandbox-contract";
import { ProseField } from "@intentic/extension-ui";
import { type ComponentPublicInstance, computed, onBeforeUnmount } from "vue";
import { postsATitle } from "./postText";

const { draft } = defineProps<{ draft: DraftSummary }>();
const emit = defineEmits<{ close: []; touch: [] }>();

const content = defineModel<string>(`content`, { required: true });
const title = defineModel<string>(`title`, { required: true });

// A headline box only where the platform publishes one. Everywhere else `title` is the agent's note about the
// draft (postText.ts) — it is shown under the post, and editing the post has no business rewriting it.
const headlined = computed(() => postsATitle(draft.platform, draft.target));

/* The field exists only after the click, so `autofocus` — an initial-page-load attribute — would never fire.
 * The caret goes to the end rather than selecting everything: this is a change to a post, not a replacement of
 * it, and a stray keystroke over a full selection would wipe one. */
const caretAtEnd = (el: Element | ComponentPublicInstance | null): void => {
    const field = (el as { field?: HTMLTextAreaElement } | null)?.field;
    if (field !== undefined) {
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
    }
};

// The row disappearing out from under an open editor — approved, rejected, refetched away — must not be what
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
