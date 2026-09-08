<script setup lang="ts">
import { type ChangeStatus, STATUS_CLASS, STATUS_LETTER } from "./changeStatus.js";

// Git's one-letter status (M, A, D, R, !) in a fixed-width cell; `w-3` centered keeps path columns aligned regardless
// of the letter. In the kit rather than the app because an extension needs it too. Sits beside DiffStat, the other half
// of a changed-file row.

defineProps<{ status: ChangeStatus }>();
</script>

<template>
    <span class="w-3 shrink-0 text-center font-mono text-2xs" :class="STATUS_CLASS[status]">{{ STATUS_LETTER[status] }}</span>
</template>
