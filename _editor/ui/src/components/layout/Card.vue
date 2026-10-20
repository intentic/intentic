<!-- Surface card primitive. On a surface (a dialog, a card, a group's card) it draws none: that surface already is one (overlays/surfaceGround.ts). -->
<script setup lang="ts">
import { provideSurfaceGround, useSurfaceGround } from "../overlays/surfaceGround.js";

const { dashed = false } = defineProps<{ dashed?: boolean }>();
const onGround = useSurfaceGround();
provideSurfaceGround();
</script>

<template>
    <div :class="onGround ? `` : { 'ui-card': true, 'ui-card-dashed': dashed }">
        <slot />
    </div>
</template>
