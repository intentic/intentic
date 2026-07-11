<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { createTerminalSession, disposeTerminalSession, mountTerminalSession, type TerminalSession } from "../composables/terminal/terminalSession";

/* One embedded xterm attached to a named tmux session — the single-pane cousin of the workspace terminal panel
 * (both ride composables/terminalSession). Used by the panel page to attach to `panel-<key>` dev-server
 * sessions: those are attach-only daemon-side, so a missing session emits the exit frame → `exit` is emitted
 * and the pane is disposed (no attach-fail loop). Switching `session` swaps to a fresh attach. */

const { session } = defineProps<{ session: string }>();
const emit = defineEmits<{ exit: [] }>();

const host = ref<HTMLElement>();
let current: TerminalSession | undefined;

const open = (): void => {
    if (current !== undefined) {
        disposeTerminalSession(current);
        current = undefined;
    }
    if (host.value === undefined) {
        return;
    }
    current = createTerminalSession(session, () => {
        emit(`exit`);
    });
    mountTerminalSession(current, host.value);
};

// The host ref lands after mount; re-open on session switch.
watch([host, () => session], open);
onBeforeUnmount(() => {
    if (current !== undefined) {
        disposeTerminalSession(current);
    }
});
</script>

<template>
    <div ref="host" class="h-full min-h-0 w-full"></div>
</template>
