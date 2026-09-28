<!-- Desktop-sync toggle, presented as reference material rather than a decision the user must make. -->
<script setup lang="ts">
import Checkbox from "primevue/checkbox";
import { useT } from "@intentic/ui/i18n";

// The folder the sandbox mirrors to. Shown only while the switch is on: off, the label already says what the
// switch does, and a sales line for the default option is the loudest thing in the quietest row. A project setup
// passes its folder's name instead: that folder is why the sandbox exists, so it is stated, never offered as a switch.
const t = useT();

const { folder = ``, project = `` } = defineProps<{ folder?: string; project?: string }>();
const enabled = defineModel<boolean>({ required: true });
</script>

<template>
    <p v-if="project !== ``" class="flex min-w-0 items-start gap-2 text-xs text-muted">
        <Icon name="folder" class="mt-0.5 shrink-0" />
        <span class="flex min-w-0 flex-col gap-0.5">
            <span>{{ t(`setup.setupSyncOption.syncsWithFolderYouPicked`) }}</span>
            <code class="min-w-0 truncate">{{ project }}</code>
        </span>
    </p>
    <div v-else class="flex min-w-0 flex-col gap-0.5 text-xs text-muted opacity-80 transition-opacity focus-within:opacity-100 hover:opacity-100">
        <!-- The label covers only the option name so folder clicks remain folder interactions. -->
        <label class="flex cursor-pointer items-center gap-2">
            <Checkbox v-model="enabled" :binary="true" size="small" />
            <span>{{ t(`setup.setupSyncOption.alsoSyncLocalFolder`) }}</span>
        </label>
        <code v-if="enabled && folder !== ``" class="min-w-0 truncate pl-6">{{ folder }}</code>
    </div>
</template>
