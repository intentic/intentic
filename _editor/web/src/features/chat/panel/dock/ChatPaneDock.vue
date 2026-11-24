<!-- One chat pane's dock over its composer, in its order: what the work needs next, the turn's way on (the slot), what it left running, and what the agent waits on the reader for. -->
<script setup lang="ts">
import ChatLeftRunning from "../jobs/ChatLeftRunning.vue";
import ChatWaitingBar from "../pane/ChatWaitingBar.vue";
import ChatDock from "./ChatDock.vue";
import ChatPaneLines from "./ChatPaneLines.vue";

// THE ORDER IS THE POINT: what to do with what the chat did first (ChatPaneLines); then the turn that stopped and the way
// on or out of it, which the pane hands in since only it knows the turn (the slot); what the turn left running; and last,
// against the composer whose words a plan's answers carry, what the agent waits on the reader for (ChatWaitingBar), in a
// subagent's chat too, since a permission there is the reader's. The scratch pad's one-line bar (`quick`) has room for
// the first alone.

defineProps<{ quick: boolean; canDrive: boolean }>();
// The plan's two answers, done by the composer (composerSend), whose box holds the notes either one may carry.
const emit = defineEmits<{ approve: []; keepPlanning: [] }>();
</script>

<template>
    <ChatDock>
        <ChatPaneLines />
        <slot />
        <ChatLeftRunning v-if="!quick" />
        <ChatWaitingBar v-if="!quick" :can-drive="canDrive" @approve="emit(`approve`)" @keep-planning="emit(`keepPlanning`)" />
    </ChatDock>
</template>
