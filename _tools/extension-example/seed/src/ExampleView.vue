<script setup lang="ts">
import { onMounted, watch } from "vue";
import { markSeen } from "./badge";
import { NOTES_PATH } from "./notes";
import { useNotes } from "./useNotes";

// Rail view mounted by the host at /ext/example, workspace-wide (no activation props). Classes are host-provided only;
// nothing else scans this bundle, so a class works only if the host's generated scale promises it. Two rules:
// Name a role, not a colour (text-muted, bg-card, border-line): the theme recolours it for light/dark; a literal colour
// breaks on half the installs.
// Size against the container (@container, @lg:), not the window (lg:): this view can be dragged narrow, popped out, or
// stacked under a chat.
// One-off values (`w-[37px]`) render as nothing; use the scale or ship your own stylesheet via activate().

const { all, shown, limit, isLoading } = useNotes();

// Opening the view is the acknowledgement the badge clears on.
onMounted(() => markSeen(all.value.length));
watch(all, (notes) => markSeen(notes.length));
</script>

<template>
    <div class="ui-page @container">
        <h1 class="text-xl font-semibold text-content">Example</h1>
        <p class="mt-1 text-sm text-muted">
            Notes the agent left with <code class="ui-code">intentic-example add "…"</code>, read from
            <code class="ui-code">{{ NOTES_PATH }}</code> and refreshed by the daemon's file watcher: no polling.
        </p>

        <div v-if="isLoading" class="mt-4 text-sm text-muted">Loading…</div>

        <div v-else-if="shown.length === 0" class="ui-card ui-card-dashed mt-4">
            <p class="text-sm text-muted">
                No notes yet. Ask the agent to <em>leave an example note</em>, or run <code class="ui-code">intentic-example add "hello"</code> in a
                terminal.
            </p>
        </div>

        <ul v-else class="mt-4 flex list-none flex-col gap-2 p-0">
            <li v-for="note in shown" :key="note.at" class="ui-card flex flex-col gap-0.5 @lg:flex-row @lg:items-baseline @lg:gap-3">
                <div class="min-w-0 flex-1 text-content">{{ note.text }}</div>
                <div class="shrink-0 text-2xs text-subtle">{{ note.at }}</div>
            </li>
        </ul>

        <p v-if="all.length > limit" class="mt-3 text-2xs text-muted">
            Showing {{ limit }} of {{ all.length }}: raise <strong>Notes shown</strong> in Settings → Extensions.
        </p>
    </div>
</template>
