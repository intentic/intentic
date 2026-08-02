<script setup lang="ts">
import { onMounted, watch } from "vue";
import { markSeen } from "./badge";
import { NOTES_PATH } from "./notes";
import { useNotes } from "./useNotes";

/* The rail view. Mounted by the host at /ext/example with `repo` (and any Activation props) bound — this
 * activation is workspace-wide, so it takes none.
 *
 * ON STYLING, which is the one place a git-installed extension differs from a first-party one. The app's
 * Tailwind build scans its own sources and the first-party extension packages; it cannot scan a bundle it
 * doesn't build, so utility classes in a third-party view resolve only by accident — whichever ones the app uses
 * elsewhere. What IS reliably available is everything the design system SHIPS as authored CSS: the `.ui-*`
 * component classes (`.ui-page`, `.ui-card`, `.ui-field`, `.ui-code`) and the role tokens behind them
 * (`--color-card`, `--color-content`, `--color-muted`, `--color-line`), which flip with the light/dark scheme on
 * their own. So this view is built from those two things, and it recolors with the shell for free.
 *
 * Note also that vite's lib build emits an SFC style block as a SEPARATE css asset, and the loader imports one
 * JS file from a blob URL — nothing fetches that asset. So: style inline, or inject a sheet from activate(). */

const { all, shown, limit, isLoading } = useNotes();

// Opening the view IS the acknowledgement the badge clears on.
onMounted(() => markSeen(all.value.length));
watch(all, (notes) => markSeen(notes.length));
</script>

<template>
    <div class="ui-page">
        <h1 :style="{ fontSize: `1.25rem`, fontWeight: 600, color: `var(--color-content)` }">Example</h1>
        <p :style="{ color: `var(--color-muted)`, marginTop: `0.25rem` }">
            Notes the agent left with <code class="ui-code">intentic-example add "…"</code>, read from
            <code class="ui-code">{{ NOTES_PATH }}</code> and refreshed by the daemon's file watcher — no polling.
        </p>

        <div v-if="isLoading" :style="{ color: `var(--color-muted)`, marginTop: `1rem` }">Loading…</div>

        <div v-else-if="shown.length === 0" class="ui-card ui-card-dashed" :style="{ marginTop: `1rem` }">
            <p :style="{ color: `var(--color-muted)` }">
                No notes yet. Ask the agent to <em>leave an example note</em>, or run <code class="ui-code">intentic-example add "hello"</code> in a
                terminal.
            </p>
        </div>

        <ul v-else :style="{ marginTop: `1rem`, display: `flex`, flexDirection: `column`, gap: `0.5rem`, listStyle: `none`, padding: 0 }">
            <li v-for="note in shown" :key="note.at" class="ui-card">
                <div :style="{ color: `var(--color-content)` }">{{ note.text }}</div>
                <div :style="{ color: `var(--color-muted)`, fontSize: `0.75rem`, marginTop: `0.25rem` }">{{ note.at }}</div>
            </li>
        </ul>

        <p v-if="all.length > limit" :style="{ color: `var(--color-muted)`, fontSize: `0.75rem`, marginTop: `0.75rem` }">
            Showing {{ limit }} of {{ all.length }} — raise <strong>Notes shown</strong> in Settings → Extensions.
        </p>
    </div>
</template>
