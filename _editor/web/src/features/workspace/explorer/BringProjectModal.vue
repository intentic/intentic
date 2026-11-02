<!-- "Bring a project in": the empty workspace's choices (BringProjectChoices) as a dialog, for a workspace that already
     has files, where that pane is the home and the choices are not on screen. It only starts things: a clone goes on in
     the notification lane, so the dialog closes on the press rather than holding the reader while it runs. -->
<script setup lang="ts">
import { Modal } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import BringProjectChoices from "./BringProjectChoices.vue";
import { useBringProject } from "./useBringProject";

const t = useT();
const { open } = useBringProject();

// The page owns the file picker (and refuses it for a read-only member), so this only says it was asked for.
const emit = defineEmits<{ pick: [] }>();

const pick = (): void => {
    open.value = false;
    emit(`pick`);
};
</script>

<template>
    <Modal v-model:open="open" size="md" :header="t(`workspace.bringProject.title`)">
        <BringProjectChoices autofocus @pick="pick" @done="open = false" />
    </Modal>
</template>
