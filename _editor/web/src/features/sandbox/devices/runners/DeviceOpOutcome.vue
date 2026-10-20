<!-- One press that worked on a machine, as one quiet line where it was pressed; the machine's own words a click away. -->
<script setup lang="ts">
import { Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";

// A line rather than a box: the row it sits under already shows the new state (the label flipped, the badge moved),
// so this only has to say the press landed. What the machine printed is evidence few readers want, so it waits
// behind Details instead of filling the row with narration, session names and folder paths.
const t = useT();

const { message, detail, idle = false } = defineProps<{
    message: string;
    /** The machine's own output, verbatim; absent when it said nothing the line doesn't. */
    detail?: string | undefined;
    /** The machine took the press and had nothing to do: said as information, not as a tick. */
    idle?: boolean;
}>();

const open = ref(false);
// Put away here rather than in the ledger: the line unmounts while the next press runs, so a fresh answer always shows.
const dismissed = ref(false);
</script>

<template>
    <div v-if="!dismissed" class="flex flex-col gap-1" role="status">
        <div class="flex min-w-0 items-start gap-1.5 text-xs text-muted">
            <Icon :name="idle ? `info-circle` : `check-circle`" class="shrink-0" :class="idle ? `text-subtle` : `text-success`" aria-hidden="true" />
            <span class="min-w-0 flex-1 whitespace-pre-line break-words">{{ message }}</span>
            <button
                v-if="detail !== undefined"
                type="button"
                :class="ui.textButton({ tone: `subtle`, size: `xs`, flush: true }, `shrink-0`)"
                :aria-expanded="open"
                @click="open = !open"
            >
                {{ open ? t(`sandbox.deviceOpOutcome.hideDetails`) : t(`sandbox.deviceOpOutcome.details`) }}
                <Icon :name="open ? `chevron-up` : `chevron-down`" class="text-3xs" aria-hidden="true" />
            </button>
            <button type="button" :class="ui.iconButton({ size: `xs`, tone: `subtle` }, `-my-0.5`)" :aria-label="t(`sandbox.deviceOpOutcome.dismiss`)" @click="dismissed = true">
                <Icon name="times" class="text-2xs" aria-hidden="true" />
            </button>
        </div>
        <!-- Verbatim, wrapped rather than scrolled sideways: a folder path is the long line, and its end is the part that matters. -->
        <pre
            v-if="open && detail !== undefined"
            class="max-h-48 overflow-auto rounded-lg border border-line bg-canvas p-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-all text-subtle"
        >{{ detail }}</pre>
    </div>
</template>
