<script setup lang="ts">
import { computed } from "vue";
import type { BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import FileChooserCard from "../uploads/FileChooserCard.vue";
import type { WindowTools } from "../windowTools";
import PageDialog from "./PageDialog.vue";
import PermissionPrompt from "./PermissionPrompt.vue";
import SiteInfo from "./SiteInfo.vue";
import { siteName } from "./permissionWords";

// What the page in front asks of the person, drawn over its picture where a browser draws its own: a JavaScript dialog,
// a permission prompt in the top corner, a file chooser's card (and the drop zone while files are dragged in), and the
// padlock's site info.

const { tools, dialog } = defineProps<{ tools: WindowTools; dialog: BrowserSession[`dialog`] }>();
// The dialog's answer, a prompt's text with it; the view says it over the window's socket.
const emit = defineEmits<{ dialog: [accept: boolean, text?: string] }>();
const secure = computed(() => tools.site.origin.value?.startsWith(`https:`) === true);
</script>

<template>
    <PageDialog v-if="dialog" :dialog="dialog" @answer="(accept, text) => emit(`dialog`, accept, text)" />
    <PermissionPrompt :tools="tools.permission" />
    <FileChooserCard :tools="tools.files" :site="siteName(tools.site.origin.value)" :dragging="tools.files.dragging.value" />
    <SiteInfo :tools="tools.site" :secure="secure" />
</template>
