<!-- The entry being named, drawn first in the open folder before it exists, in the shape it will take: a folder as a chip
     (HomeChip.vue), a file as a tile (HomeTile.vue), so nothing changes shape when the name is committed. -->
<script setup lang="ts">
import { focusInput } from "@intentic/ui/inline-rename";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { type, error } = defineProps<{
    type: "dir" | "file";
    // Why the name was refused, said under the field.
    error?: string;
}>();

const draft = defineModel<string>({ required: true });

// `blur` apart from `commit`: the home decides whether a blur keeps or drops an empty name (useHomeActions).
const emit = defineEmits<{ commit: []; cancel: []; blur: [] }>();
</script>

<template>
    <!-- The field owns its keys; none reach the home. The grids are the chips' and the tiles' own (HomeProbe.vue). -->
    <div
        class="grid pt-3"
        :class="type === 'dir' ? 'grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-1.5' : 'grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-0.5'"
    >
        <div v-if="type === 'dir'" class="flex flex-col gap-1">
            <div class="flex h-9 min-w-0 items-center gap-2 rounded-lg bg-content/[0.045] px-2.5 text-xs">
                <Icon name="folder" class="shrink-0 text-sm text-muted" aria-hidden="true" />
                <input
                    v-model="draft"
                    type="text"
                    :aria-label="t(`workspace.words.newFolderName`)"
                    class="ui-field-box ui-field-inline h-6 min-w-0 flex-1 px-1 text-xs"
                    :class="error !== undefined ? 'ui-field-error-box' : ''"
                    @click.stop
                    @keydown.stop
                    @keydown.enter.prevent="emit('commit')"
                    @keydown.esc.prevent="emit('cancel')"
                    @blur="emit('blur')"
                    @vue:mounted="focusInput"
                />
            </div>
            <p v-if="error !== undefined" class="px-2.5 text-2xs text-danger">{{ error }}</p>
        </div>
        <div v-else class="flex flex-col items-center gap-1.5 rounded-lg px-2 pt-3 pb-2">
            <span class="flex h-14 items-center justify-center">
                <Icon name="file" class="text-[2.125rem] text-muted" />
            </span>
            <input
                v-model="draft"
                type="text"
                :aria-label="t(`workspace.words.newFileName`)"
                class="ui-field-box ui-field-inline w-full min-w-0 px-1 text-center text-xs"
                :class="error !== undefined ? 'ui-field-error-box' : ''"
                @click.stop
                @keydown.stop
                @keydown.enter.prevent="emit('commit')"
                @keydown.esc.prevent="emit('cancel')"
                @blur="emit('blur')"
                @vue:mounted="focusInput"
            />
            <p v-if="error !== undefined" class="text-center text-2xs text-danger">{{ error }}</p>
        </div>
    </div>
</template>
