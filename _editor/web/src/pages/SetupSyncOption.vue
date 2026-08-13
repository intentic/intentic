<!-- DESKTOP SYNC, AS A SWITCH RATHER THAN A DECISION. It is on unless somebody objects, and almost nobody
     does — so it belongs with the reference material about what the command does, not in the reader's path to
     pasting it. From `xl` the setup page renders it in that column, under "What this does"; below `xl` there is
     no column, so the run card carries it instead. Exactly one of the two is visible, and both drive the same
     `v-model`, which is why this is a component rather than markup written twice. -->
<script setup lang="ts">
import Checkbox from "primevue/checkbox";

// The folder the sandbox mirrors to. Shown only while the switch is on: off, the label already says what the
// switch does, and a sales line for the default option is the loudest thing in the quietest row.
const { folder = `` } = defineProps<{ folder?: string }>();
const enabled = defineModel<boolean>({ required: true });
</script>

<template>
    <div class="flex min-w-0 flex-col gap-0.5 text-xs text-muted opacity-80 transition-opacity focus-within:opacity-100 hover:opacity-100">
        <!-- The <label> stops at the option's NAME: a label toggles on any click inside it, and the folder
             below it is a path people select and read. -->
        <label class="flex cursor-pointer items-center gap-2">
            <Checkbox v-model="enabled" :binary="true" size="small" />
            <span>Also sync a local folder</span>
        </label>
        <code v-if="enabled && folder !== ``" class="min-w-0 truncate pl-6">{{ folder }}</code>
    </div>
</template>
