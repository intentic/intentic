<!-- Bring a project into a sandbox, or open a folder through the desktop app when looking at this computer's files. -->
<script setup lang="ts">
import { Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { askLocalApp, localFace } from "../../../app/environments/local";
import BringProjectModal from "./BringProjectModal.vue";
import { useBringProject } from "./useBringProject";

const { look = `sidebar` } = defineProps<{ look?: `sidebar` | `phone` | `home` }>();
// The page owns the file picker, so the dialog's upload choice is passed up. A button of the phone's carries its dialog;
// the desktop's two buttons (Files header, home) share the one its page mounts, which is why only `phone` renders it.
const emit = defineEmits<{ pick: [] }>();
const t = useT();
const { show } = useBringProject();
const local = computed(() => localFace() !== undefined);
const label = computed(() => t(local.value ? `local.emptyFolder.openFolder` : `workspace.bringProject.title`));
const icon = computed(() => local.value ? `folder-open` : `arrow-down-left`);
const bring = (): void => {
    // A folder window has no import dialog or sandbox. Open the chosen project in its own window, so this one's
    // unsaved edits stay here; the app's native picker owns the cancellation and opening (local.rs `pick`).
    if (local.value) {
        askLocalApp(`open-folder`);
    } else {
        show();
    }
};
</script>

<template>
    <button
        v-if="look === `home`"
        type="button"
        class="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-2xs font-medium text-muted transition-colors hover:text-content"
        @click.stop="bring"
    >
        <Icon :name="icon" class="text-[0.7rem]" aria-hidden="true" />
        {{ label }}
    </button>
    <button
        v-else
        type="button"
        :class="look === `phone` ? ui.iconButton({ size: `xl` }) : ui.iconButton({ size: `xs` }, `shrink-0 hover:bg-transparent`)"
        v-tooltip.bottom="look === `phone` ? undefined : local ? label : t(`workspace.bringProject.tip`)"
        :aria-label="label"
        @click="bring"
    >
        <Icon :name="icon" :class="look === `phone` ? `text-base` : `text-xs`" />
    </button>
    <BringProjectModal v-if="look === `phone` && !local" @pick="emit(`pick`)" />
</template>
