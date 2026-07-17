<script setup lang="ts">
import ChatPanel from "../chat/ChatPanel.vue";

/* The mobile Chat tab: the shared chat singleton, full-screen. On desktop the same ChatPanel lives docked in
 * the shell's chat column (or popped out), so this route redirects there (router mobileOnly guard). */
</script>

<template>
    <ChatPanel class="h-full" />
</template>
