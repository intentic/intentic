<!-- Long-form info affordance: a small (i) icon that opens a modal holding a full write-up of how something
     works. The click-to-open sibling of <InfoHint> — same icon, same intent, different budget. InfoHint's
     hover card is a glance (a couple of sentences, read while the cursor rests on the icon); this is a read
     (headings, lists, several paragraphs), so it stays open, scrolls, and lets the text be selected. Reach for
     it whenever the explanation is longer than a hover is comfortable to hold, and for anything a touch user
     needs — there is no hover on a phone. The body is projected via <slot>, so each call site supplies its own
     prose; `title` names the dialog AND the icon (a screen reader hears the same thing the header shows). -->
<script setup lang="ts">
import Dialog from "primevue/dialog";
import { ref } from "vue";
import Icon from "./Icon.vue";

defineProps<{ title: string }>();

const open = ref(false);
</script>

<template>
    <button
        type="button"
        class="inline-flex items-center text-subtle transition-colors hover:text-content"
        :aria-label="title"
        v-tooltip.top="title"
        @click="open = true"
    >
        <Icon name="info-circle" />
    </button>
    <!-- The body is a @container: a write-up that lays itself out in two columns keys off the DIALOG's width
         (36rem, or 95vw on a phone) rather than the window's — the two disagree on every phone. -->
    <Dialog
        v-model:visible="open"
        :modal="true"
        :draggable="false"
        :dismissable-mask="true"
        :header="title"
        :style="{ width: '36rem', maxWidth: '95vw' }"
        :pt="{ content: { class: `@container max-h-[70dvh] overflow-y-auto` } }"
    >
        <slot />
    </Dialog>
</template>
