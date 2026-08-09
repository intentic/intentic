<!-- THE POST, OPEN FOR CHANGES. A draft arrives written by the agent and is usually most of the way right;
     often it is one word away, and until this existed the only ways to fix that word were to reject the draft
     and hope the next proposal was better, or to go and edit the JSON file by hand. Both throw away a decision
     the reviewer had already made. Approve/reject is a verdict on someone else's sentence; this is the seam
     where it becomes the owner's own.

     IT IS THE SAME COLUMN THE POST IS READ IN — the measure, the size and the leading of DraftPost, because the
     whole reason this page typesets a draft as a post is that the reviewer is approving these exact bytes. A
     box that reflowed the words the moment you clicked into it would be showing you a second, different post
     and asking you to trust that they match.

     THE COUNT IS LIVE, AND ONLY HERE DOES IT HAVE TO BE. The row's footer states a length you can only accept
     or reject; while you are typing it is the thing you are steering by, so it sits under the box and turns as
     you cross the platform's cap — 281 characters on X is not a worse post, it is no post.

     ESCAPE CANCELS, BLUR DOES NOT — the one place this deliberately parts company with ScheduleControl beside
     it. A date input holds a single token you can retype in a second, so closing it on blur costs nothing; a
     paragraph someone has spent a minute rewriting is not that, and a stray click on the page behind must not
     be able to throw it away. Nor may it be saved out from under them: while a row is open for editing, its
     Approve and Reject actions are gone, because a post approved with unsaved words in the box would publish
     the sentence the owner had just replaced. -->
<script setup lang="ts">
import type { DraftSummary } from "@intentic-app/api-contract";
import { cmp } from "@intentic/ui";
import Button from "primevue/button";
import { type ComponentPublicInstance, computed, ref } from "vue";
import { limitOf, type PostEdit, postEdit, postsATitle } from "./postText";

const { draft, saving = false } = defineProps<{
    draft: DraftSummary;
    /** The queue's own mutation state — one save at a time, and the box stays open until that one lands. */
    saving?: boolean;
}>();

const emit = defineEmits<{ cancel: []; save: [changes: PostEdit] }>();

const content = ref(draft.content);
const title = ref(draft.title ?? ``);

// A headline box only where the platform publishes one. Everywhere else `title` is the agent's note about the
// draft (postText.ts) — it is shown under the post, and editing the post has no business rewriting it.
const headlined = computed(() => postsATitle(draft.platform, draft.target));

const limit = limitOf(draft.platform);
const over = computed(() => content.value.length > (limit ?? Infinity));
const counter = computed(() =>
    limit === undefined
        ? `${content.value.length.toLocaleString()} characters`
        : `${content.value.length.toLocaleString()} / ${limit.toLocaleString()}`,
);

// An empty post is not a post, and a platform that publishes headlines will not take a blank one. Over the cap
// is left saveable on purpose: the draft is being worked on, and a half-finished edit you cannot park is worse
// than one the footer will keep calling too long.
const incomplete = computed(() => content.value.trim() === `` || (headlined.value && title.value.trim() === ``));

// The box exists only after the click, so `autofocus` — an initial-page-load attribute — would never fire. The
// caret goes to the end rather than selecting everything: this is a change to a post, not a replacement of it.
const focusOnMount = (el: Element | ComponentPublicInstance | null): void => {
    if (el instanceof HTMLTextAreaElement) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
    }
};

const commit = (): void => {
    if (incomplete.value || saving) {
        return;
    }
    const changes = postEdit(draft, { content: content.value, title: title.value });
    // Untouched: close it rather than re-post an identical draft and flash the row for a click that did nothing.
    if (changes === undefined) {
        emit(`cancel`);
        return;
    }
    emit(`save`, changes);
};
</script>

<template>
    <div class="max-w-[64ch]">
        <input
            v-if="headlined"
            v-model="title"
            type="text"
            :class="cmp.input(`mb-2 block w-full text-base font-semibold leading-snug`)"
            aria-label="Post title"
            @keydown.escape="emit(`cancel`)"
            @keydown.enter.prevent="commit"
        />
        <!-- `field-sizing-content` grows the box with the post so a long draft isn't edited through a four-line
             porthole; `rows` is its floor, and the cap keeps a YouTube description from pushing the queue's
             other sections off the screen. -->
        <textarea
            :ref="focusOnMount"
            v-model="content"
            rows="4"
            :class="
                cmp.input(
                    `field-sizing-content block max-h-[60vh] w-full resize-y text-[0.9375rem] leading-[1.7]`,
                    over ? `border-danger/60 hover:border-danger focus:border-danger` : ``,
                )
            "
            aria-label="Post text"
            @keydown.escape="emit(`cancel`)"
            @keydown.ctrl.enter="commit"
            @keydown.meta.enter="commit"
        ></textarea>

        <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button label="Save" size="small" :disabled="incomplete || saving" @click="commit">
                <template #icon><Icon name="check" /></template>
            </Button>
            <button type="button" :class="cmp.linkButton(`text-muted hover:text-content`)" :disabled="saving" @click="emit(`cancel`)">Cancel</button>
            <span class="ml-auto text-xs" :class="over ? `text-danger` : `text-muted`">{{ counter }}</span>
        </div>
    </div>
</template>
