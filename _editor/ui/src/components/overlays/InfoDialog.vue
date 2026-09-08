<!--
    Click-to-open (i) affordance for a long write-up, the modal sibling of <InfoHint>'s hover card. Body is projected via slot; `title` names both
    the dialog and the icon.
-->
<script setup lang="ts">
import { ref } from "vue";
import Icon from "../primitives/Icon.vue";
import Modal from "./Modal.vue";

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
         (<Modal>'s `md`, which is 36rem until the screen is narrower than that) rather than the window's: the
         two disagree on every phone. -->
    <Modal v-model:open="open" size="md" :header="title">
        <div class="@container"><slot /></div>
    </Modal>
</template>
