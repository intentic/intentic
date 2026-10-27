<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";

// The model picker's one row the providers the reader cannot run yet fold behind (foldUnconnected), and open below.
// Named by what waits there: providers to connect, or, when every one of them is withheld from the reader (Access ▸
// People), models that are not shared with them, since connecting would not make those theirs.
const open = defineModel<boolean>({ required: true });
const { withheld = false } = defineProps<{ withheld?: boolean }>();
const t = useT();
</script>

<template>
    <button
        type="button"
        class="ui-row-select mt-1 flex w-full items-center gap-1.5 border-t border-line px-3 py-2 text-left text-2xs text-subtle max-md:min-h-11"
        :aria-expanded="open"
        @click="open = !open"
    >
        <Icon :name="open ? `chevron-up` : `chevron-down`" class="shrink-0 text-[0.6rem]" aria-hidden="true" />
        <span>{{ withheld ? t(`chat.modelPicker.notSharedFold`) : t(`chat.modelPicker.addAnotherProvider`) }}</span>
    </button>
</template>
