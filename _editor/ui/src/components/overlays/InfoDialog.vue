<!-- Click-to-open (i) affordance for a long write-up, the modal sibling of <InfoHint>'s hover card. -->
<script setup lang="ts">
import { ref } from "vue";
import Icon from "../primitives/Icon.vue";
import Modal from "./Modal.vue";

// `lg` for a body that IS a table, whose columns need the room `md` would fold into lines.
const { size = `md` } = defineProps<{ title: string; size?: `md` | `lg` }>();

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
    <!-- The dialog body switches to two columns when its container is wide enough. -->
    <Modal v-model:open="open" :size="size" :header="title">
        <div class="@container"><slot /></div>
    </Modal>
</template>
