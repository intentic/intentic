<script setup lang="ts">
import { onMounted, watch } from "vue";
import { markSeen } from "./badge";
import { NOTES_PATH } from "./notes";
import { useNotes } from "./useNotes";

/* The rail view. Mounted by the host at /ext/example with `repo` (and any Activation props) bound — this
 * activation is workspace-wide, so it takes none.
 *
 * ON STYLING. Layout, typography, spacing and colour are PROVIDED BY THE HOST, and they are a promise rather
 * than a side effect: the whole spacing scale, every step of the type scale and every colour role are generated
 * whether or not anything is currently using one. That matters here more than anywhere, because nothing scans
 * this bundle for class names — nobody builds it but you — so a class works if and only if the host promised
 * it. (This view used to be written in inline styles for exactly that reason, back when the app inferred its
 * classes from whatever it happened to be reading.)
 *
 * Two rules follow, and they are the whole of it:
 *
 *   NAME A ROLE, NOT A COLOUR — `text-muted`, `bg-card`, `border-line`, `text-danger`. The theme decides what
 *   each means in light and dark, so the view recolours with the shell for free and picks up the reader's
 *   accent. A literal colour is a view that looks wrong on half the installs.
 *
 *   SIZE AGAINST THE CONTAINER — `@container` and `@lg:`, not `lg:`. This renders into a pane the reader can
 *   drag narrow, pop out, or stack under a chat. The window's width is not the question being asked.
 *
 * What the promise cannot cover is one-off values (`w-[37px]`, `max-w-[64ch]`, `text-[0.65rem]`): they are
 * infinite, so no promise reaches them, and they render as nothing at all. Use the scale, reach for a kit
 * component, or ship the rule in your own stylesheet — added by activate() and removed when the extension is
 * switched off. Note too that vite's lib build emits an SFC <style> block as a SEPARATE css asset, and the
 * loader imports one JS file from a blob URL, so nothing would ever fetch it. */

const { all, shown, limit, isLoading } = useNotes();

// Opening the view IS the acknowledgement the badge clears on.
onMounted(() => markSeen(all.value.length));
watch(all, (notes) => markSeen(notes.length));
</script>

<template>
    <div class="ui-page @container">
        <h1 class="text-xl font-semibold text-content">Example</h1>
        <p class="mt-1 text-sm text-muted">
            Notes the agent left with <code class="ui-code">intentic-example add "…"</code>, read from
            <code class="ui-code">{{ NOTES_PATH }}</code> and refreshed by the daemon's file watcher — no polling.
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
            Showing {{ limit }} of {{ all.length }} — raise <strong>Notes shown</strong> in Settings → Extensions.
        </p>
    </div>
</template>
