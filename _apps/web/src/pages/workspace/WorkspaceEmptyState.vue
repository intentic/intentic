<!-- Shown in the viewer pane when no file is open. -->
<script setup lang="ts">
defineEmits<{ pick: [] }>();
</script>

<template>
    <div class="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
        <button
            type="button"
            class="flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-line px-10 py-8 transition-colors hover:border-primary-500 hover:bg-primary-600/5 focus:outline-none focus-visible:border-primary-500"
            @click="$emit('pick')"
        >
            <Icon name="upload" class="text-3xl text-subtle" />
            <p class="text-base font-semibold text-content">Drop your work here</p>
            <p class="max-w-xs text-xs text-muted">Then ask chat to organize, refactor, or explain it — it edits this working tree for you.</p>
        </button>
        <span class="inline-flex items-center gap-1.5 rounded-full bg-subtle/10 px-2.5 py-1 text-2xs font-medium text-subtle">
            <Icon name="lock" class="text-[0.7rem]" />
            Files stay on your sandbox machine — nowhere else
        </span>
    </div>
</template>
