<!-- A post under review, read and written in the same place: pressing its words (or Enter on it) puts them under the caret in
     the same column and measure, and leaving them renders them again, written (usePostEdit.ts). There is no pencil to press
     first and no Save: the words themselves are the way in. -->
<script setup lang="ts">
import type { PostApprovalSummary } from "@intentic/sandbox-contract/schemas/approvals";
import { nextTick, ref } from "vue";
import PostBody from "./PostBody.vue";
import PostEditor from "./PostEditor.vue";
import { t } from "./i18n.js";

const {
    post,
    label,
    writable = false,
    writing = false,
} = defineProps<{
    post: PostApprovalSummary;
    /** The post's one-line name, for what a screen reader calls the press target. */
    label: string;
    /** May this reader change it at all: the same people who may approve it. */
    writable?: boolean;
    /** Its words are under the caret now. */
    writing?: boolean;
}>();
const emit = defineEmits<{ open: []; close: []; touch: [] }>();

const content = defineModel<string>("content", { required: true });
const title = defineModel<string>("title", { required: true });

const box = ref<HTMLElement | null>(null);

// A press that followed a link, unfolded a long post or selected words is reading, not asking to write.
const pressToWrite = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : undefined;
    if (writing || window.getSelection()?.toString() || target?.closest(`a, button`)) {
        return;
    }
    emit(`open`);
};
// The keyboard's way in: Enter on the post itself, never on a link or button inside it.
const keyToWrite = (event: KeyboardEvent): void => {
    if (writing || event.target !== event.currentTarget) {
        return;
    }
    event.preventDefault();
    emit(`open`);
};
// Leaving the words, by a press elsewhere or Tab, renders them again and writes the last of them.
const leave = (event: FocusEvent): void => {
    const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (writing && !box.value?.contains(next)) {
        emit(`close`);
    }
};
// Esc leaves too, and hands the focus back to the post rather than to nowhere.
const escape = (): void => {
    emit(`close`);
    void nextTick(() => box.value?.focus());
};
</script>

<template>
    <PostBody v-if="!writable" :post="post" />
    <!-- A hover wash says the words can be written in, as everywhere else a value is changed where it is read. The wash's
         padding is taken back by its margin, so the words sit exactly where a reader's would. -->
    <div
        v-else
        ref="box"
        class="-mx-2 -my-1 max-w-read rounded-md px-2 py-1 transition-colors hover:bg-content/5"
        :class="writing ? `` : `cursor-text`"
        :tabindex="writing ? -1 : 0"
        :aria-label="writing ? undefined : t(`approvalsView.edit`, { item: label })"
        @click="pressToWrite"
        @keydown.enter="keyToWrite"
        @focusout="leave"
    >
        <PostEditor v-if="writing" v-model:content="content" v-model:title="title" :post="post" @touch="emit(`touch`)" @close="escape" />
        <PostBody v-else :post="post" />
    </div>
</template>
