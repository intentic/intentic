<!-- What an update brings, in the words of the people it is for: one change per line to scan, what it replaced a shade back
     under it (whatsNew.ts), and the tail of a long gap as one link rather than more lines. -->
<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { noteLines } from "./whatsNew";

const t = useT();

const { notes, more = 0 } = defineProps<{
    notes: readonly string[];
    /** How many further notes the daemon held back (MAX_UPDATE_NOTES), which the changelog has. */
    more?: number;
}>();

const lines = computed(() => notes.map((note) => ({ note, ...noteLines(note) })));
</script>

<template>
    <div class="flex flex-col gap-3.5">
        <h3 :class="ui.sectionLabelSm()">{{ t(`sandbox.sandboxUpdateCard.whatsNew`) }}</h3>
        <ul class="flex flex-col gap-3">
            <li v-for="line in lines" :key="line.note" class="flex gap-3">
                <!-- A small gold lozenge, the house's own mark, rather than a bullet that reads as a list of chores. -->
                <span class="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rotate-45 rounded-[1px] bg-primary-500/80" aria-hidden="true" />
                <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="text-sm leading-snug text-content">{{ line.head }}</span>
                    <span v-if="line.detail" class="text-xs leading-relaxed text-muted">{{ line.detail }}</span>
                </span>
            </li>
        </ul>
        <a v-if="more > 0" href="https://intentic.dev/changelog/" target="_blank" rel="noopener" :class="ui.linkButton(`ml-[1.125rem] font-medium`)">
            {{ t(`sandbox.sandboxUpdateCard.moreInChangelog`, { count: more }, more) }}
            <Icon name="arrow-up-right" class="text-2xs" aria-hidden="true" />
        </a>
    </div>
</template>
