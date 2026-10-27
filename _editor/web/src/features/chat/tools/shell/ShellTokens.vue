<script setup lang="ts">
import type { ShellToken } from "./shellLex";

// A shell line's coloured pieces (shellLex.ts; the colours are chat.css's `.sh-*`). A newline between statements, which
// a one-line row cannot show, is drawn as a return mark.

defineProps<{ tokens: readonly ShellToken[] }>();
</script>

<template>
    <template v-for="(token, index) in tokens" :key="index"
        ><span v-if="token.text === '\n'" class="sh-separator"> ⏎ </span><span v-else :class="`sh-${token.kind}`">{{ token.text }}</span></template
    >
</template>
