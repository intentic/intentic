<!-- The press that opens "Bring a project in" (BringProjectModal): an icon in a toolbar, or the words on the home's bar. -->
<script setup lang="ts">
import { Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import BringProjectModal from "./BringProjectModal.vue";
import { useBringProject } from "./useBringProject";

const { look = `sidebar` } = defineProps<{ look?: `sidebar` | `phone` | `home` }>();
// The page owns the file picker, so the dialog's upload choice is passed up. A button of the phone's carries its dialog;
// the desktop's two buttons (Files header, home) share the one its page mounts, which is why only `phone` renders it.
const emit = defineEmits<{ pick: [] }>();
const t = useT();
const { show } = useBringProject();
</script>

<template>
    <button
        v-if="look === `home`"
        type="button"
        class="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-2xs font-medium text-muted transition-colors hover:text-content"
        @click.stop="show()"
    >
        <Icon name="arrow-down-left" class="text-[0.7rem]" aria-hidden="true" />
        {{ t(`workspace.bringProject.title`) }}
    </button>
    <button
        v-else
        type="button"
        :class="look === `phone` ? ui.iconButton({ size: `xl` }) : ui.iconButton({ size: `xs` }, `shrink-0 hover:bg-transparent`)"
        v-tooltip.bottom="look === `phone` ? undefined : t(`workspace.bringProject.tip`)"
        :aria-label="t(`workspace.bringProject.title`)"
        @click="show()"
    >
        <Icon name="arrow-down-left" :class="look === `phone` ? `text-base` : `text-xs`" />
    </button>
    <BringProjectModal v-if="look === `phone`" @pick="emit(`pick`)" />
</template>
