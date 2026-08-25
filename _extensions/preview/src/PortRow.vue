<!-- ONE PORT, EXPLAINED. The row is three answers stacked in the order a reader asks them: which port, what is
     it, and where did it come from: with the evidence behind those answers (the command line, the directory,
     the pid) one click down rather than in their face.

     It carries the raw argv at all, because somebody debugging a port genuinely needs it; it just stops being
     the row's headline. That is the whole change: the same facts, ranked. A view that leads with
     `node --report-on-fatalerror --report-directory=/history/logs /opt/sandbox/dist/main.js` has told the
     reader nothing they can act on and has spent the row's most valuable line doing it.

     Shared by both groups (the user's own services and the sandbox's internals) because a row that means the
     same thing should look the same; `muted` only drops the emphasis of the action button, since nobody is
     hunting for a Preview button next to the sandbox's own plumbing.

     THE EVIDENCE OPENS FROM A CHEVRON ON THE LEFT, like every other expandable row in the app. It used to open
     from an `(i)` in the TRAILING cluster that turned into a `chevron-up`, and that was wrong three times over:
     `(i)` is <InfoHint>'s glyph, which this view already uses thirty pixels higher in its own group header for
     a hover card that toggles nothing; a morph carries no state a reader can scan a list for; and the trailing
     cluster is where the VERBS live, so the toggle sat one mis-click from the button that publishes a port to
     the public internet. <DisclosureRow> owns all of that now. `hit="pair"` because this row's description
     already carries a control of its own (the terminal link), and a disclosure that swallowed it would make
     "show me the command" and "take me to the terminal" the same press. -->
<script setup lang="ts">
import { Button, DisclosureRow, type IconName, Icon, InfoTable, StatusBadge, ui } from "@intentic/extension-ui";
import type { PortSummary } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import SharePreview from "./SharePreview.vue";

const { entry, muted = false, busy = false } = defineProps<{ entry: PortSummary; muted?: boolean; busy?: boolean }>();
const emit = defineEmits<{ preview: []; stop: []; terminal: [session: string] }>();

/* WHOSE IS IT, as a glyph: the fastest form of the answer, and the one that survives a reader skimming the
 * list instead of reading it. The vocabulary is the app's own: an agent is sparkles wherever it appears, a
 * terminal is a terminal. */
const ORIGIN_ICONS = {
    terminal: `terminal`,
    agent: `sparkles`,
    panel: `play`,
    extension: `wrench`,
    container: `box`,
    sandbox: `server`,
    unknown: `question-circle`,
} as const satisfies Record<PortSummary[`origin`], IconName>;

const open = ref(false);

const openTerminal = (): void => {
    if (entry.session !== undefined) {
        emit(`terminal`, entry.session);
    }
};

// The facts the headline no longer shows, in the order somebody debugging asks for them. Always four rows, so
// an absent one reads as "we looked and there was nothing" rather than as a row that quietly went missing.
const details = computed<string[][]>(() => [
    [`Command`, entry.command ?? `not readable: the process cleared its own argv`],
    [`Folder`, entry.cwd ?? `not readable`],
    [`Terminal`, entry.session ?? `none: nothing here can show its output or stop it`],
    [`Address`, `${entry.host}:${entry.port}${entry.pid === undefined ? `` : `  ·  process ${entry.pid}`}`],
]);
</script>

<template>
    <DisclosureRow v-model:open="open" density="compact" hit="pair">
        <!-- The origin glyph and the port number ride INSIDE the toggle: the pair is the hit area, and a
             fixed-width number is a wide, easy target that costs the row nothing. It also sets where the
             evidence below starts, since <DisclosureRow> offsets that block by this cluster's own width. -->
        <template #lead>
            <Icon :name="ORIGIN_ICONS[entry.origin]" class="shrink-0 text-sm text-subtle" />
            <!-- The port number is what the reader came looking for, and a fixed width is what makes a column
                 of them scannable rather than ragged. The "forwarded" badge rides in #meta rather than here
                 for the same reason: a badge in the lead pushes that one row's name out of the column. -->
            <span class="w-12 shrink-0 font-mono text-sm text-content">{{ entry.port }}</span>
        </template>

        <template #title>
            <span class="block truncate" :title="entry.command">{{ entry.title }}</span>
        </template>

        <!-- What it is for, and the terminal it lives in when there is one. The terminal is a link because
             reaching it is the point: a port you can see and not reach is a port you can only wonder about.
             The sentence WRAPS instead of truncating: this pane is regularly dragged to half a window, and half
             an explanation is the failure the whole row exists to fix. -->
        <template #description>
            <span class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span>{{ entry.purpose }}</span>
                <button
                    v-if="entry.session"
                    type="button"
                    :class="ui.linkButton(`shrink-0 gap-1 text-2xs text-muted hover:text-content hover:no-underline`)"
                    v-tooltip.bottom="`Open ${entry.session}: the terminal this is running in`"
                    @click="openTerminal"
                >
                    <Icon name="desktop" class="shrink-0" />
                    {{ entry.session }}
                </button>
            </span>
        </template>

        <template v-if="entry.forwarded" #meta>
            <StatusBadge variant="success" label="forwarded" size="xs" />
        </template>

        <!-- VERBS ONLY. The disclosure used to lead this cluster, which put "tell me what this is" among "open
             it", "share it" and "publish it to the internet", four presses of very different consequence in one
             row of identical 32px squares. -->
        <template #control>
            <a
                v-if="entry.previewUrl"
                :href="entry.previewUrl"
                target="_blank"
                rel="noopener"
                :class="ui.iconButton(`h-8 w-8`)"
                :aria-label="`Open the port ${entry.port} preview in a new tab`"
                v-tooltip.bottom="'Open in new tab'"
            >
                <Icon name="external-link" />
            </a>
            <!-- A forwarded port is public: offer the one-click shareable link right where it's exposed. -->
            <SharePreview v-if="entry.previewUrl" :url="entry.previewUrl" />
            <Button v-if="entry.forwarded" label="Stop" size="small" severity="secondary" :disabled="busy" @click="emit(`stop`)">
                <template #icon><Icon name="stop" /></template>
            </Button>
            <Button
                v-else-if="entry.forwardable"
                label="Preview"
                size="small"
                v-bind="muted ? { severity: `secondary` } : {}"
                :disabled="busy"
                @click="emit(`preview`)"
            >
                <template #icon><Icon name="play" /></template>
            </Button>
            <span v-else class="shrink-0 text-2xs text-subtle" v-tooltip.bottom="'Bound to a loopback alias the preview proxy cannot reach.'">
                not forwardable
            </span>
        </template>

        <template #below>
            <InfoTable :rows="details" />
        </template>
    </DisclosureRow>
</template>
