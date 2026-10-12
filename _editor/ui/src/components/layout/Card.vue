<!-- Surface card primitive. On a dialog it draws no surface: the dialog already is one (overlays/dialogGround.ts). -->
<script setup lang="ts">
import { useDialogGround } from "../overlays/dialogGround.js";

const { dashed = false } = defineProps<{ dashed?: boolean }>();
const onDialog = useDialogGround();
</script>

<template>
    <div :class="onDialog ? `` : { 'ui-card': true, 'ui-card-dashed': dashed }">
        <slot />
    </div>
</template>
