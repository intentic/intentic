<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref, watch } from "vue";

// The caps and degradations a conversion hit, folded to one line that says how many: the text comes first and the
// caveats on request, since a corporate template's worth of them would otherwise push the text below the fold. A
// note only one version's conversion hit is tagged with that side.

export interface ConversionNote {
    readonly text: string;
    // The one side whose conversion said this; absent when both did, or when there is only one.
    readonly side?: "before" | "after";
}

const { notes } = defineProps<{ notes: readonly ConversionNote[] }>();

const t = useT();

const open = ref(false);
// A new document's notes start folded, whatever the last one's were.
watch(
    () => notes,
    () => (open.value = false),
);
</script>

<template>
    <div v-if="notes.length > 0" class="shrink-0 border-b border-line bg-overlay px-3 py-1.5 text-2xs text-muted">
        <button type="button" :class="ui.textAction(`gap-2 text-2xs`)" :aria-expanded="open" @click="open = !open">
            <Icon :name="open ? `chevron-down` : `chevron-right`" class="shrink-0 text-[0.6rem]" />
            <Icon name="info-circle" class="shrink-0 text-[0.7rem]" />
            <span>{{ t(`workspace.conversionNotes.fromConversion`, { count: notes.length }, notes.length) }}</span>
        </button>
        <ul v-if="open" class="mt-1 space-y-0.5 pl-7">
            <li v-for="note of notes" :key="`${note.side ?? ``}:${note.text}`" class="flex items-start gap-2">
                <span v-if="note.side" class="mt-px shrink-0 rounded-sm bg-muted/30 px-1 font-medium uppercase tracking-wide text-subtle">
                    {{ note.side === `before` ? t(`workspace.conversionNotes.before`) : t(`workspace.conversionNotes.after`) }}
                </span>
                <span>{{ note.text }}</span>
            </li>
        </ul>
    </div>
</template>
