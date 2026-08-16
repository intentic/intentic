<!-- THE BUTTONS ON ONE SANDBOX'S ROW, drawn once for both apps.
     The desktop app's manager window and the web's Computers tab do the same job to the same containers, and
     they had drifted into two different sets: the window had a log tail and no Restart, the tab had a Restart and
     no log tail, and neither offered the rollback both of their backends could already do. Which verbs exist,
     what they are called, what order they sit in and which of them is red is one decision, so it is made here
     rather than twice — the callers keep only what differs, which is how the click reaches the machine.
     Their sentences and order live in sandboxVerbs.ts. -->
<script setup lang="ts">
import Button from "primevue/button";
import { computed } from "vue";
import { type SandboxVerb, VERB_LABEL, sandboxVerbs } from "./sandboxVerbs.js";

const {
    running,
    busy,
    disabled = false,
    logsOpen = false,
} = defineProps<{
    /** The container's own state — it decides whether the power slot says Start, or Restart and Stop. */
    running: boolean;
    /** The verb running on THIS row right now, which is the one that spins. */
    busy?: SandboxVerb | undefined;
    /** Something is running somewhere — every verb on every row waits, because they all drive one machine. */
    disabled?: boolean | undefined;
    /** Whether this row's log pane is showing, which is the only thing the toggle's label depends on. */
    logsOpen?: boolean | undefined;
}>();

const emit = defineEmits<{ act: [verb: SandboxVerb] }>();

const verbs = computed(() => sandboxVerbs(running));
const labelOf = (verb: SandboxVerb): string => (verb === `logs` ? (logsOpen ? `Hide logs` : `Logs`) : VERB_LABEL[verb]);
</script>

<template>
    <span class="flex shrink-0 flex-wrap items-center gap-0.5">
        <Button
            v-for="verb in verbs"
            :key="verb"
            size="small"
            :severity="verb === `remove` ? `danger` : `secondary`"
            :text="true"
            :label="labelOf(verb)"
            :loading="busy === verb"
            :disabled="disabled"
            @click="emit(`act`, verb)"
        />
    </span>
</template>
