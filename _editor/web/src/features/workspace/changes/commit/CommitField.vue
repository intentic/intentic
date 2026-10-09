<script setup lang="ts">
import type { LandedMessageDraft } from "@intentic/sandbox-contract";
import { growTextarea, type IconName, type Tip } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { useLayout } from "../../../../workbench/window/useLayout";
import { draftReport, draftRunning, type DraftReportRow } from "../changeOrigins";

// The field at the top of the Changes sidebar, shared by both halves of it: the developer's commit message
// (ReviewPanel.vue) and the maker's version name (save/SavePanel.vue). The two used to grow apart, one a field with
// its draft report on a line under it, the other a button with a sentence under it; one component is what keeps them
// one design.
//
// The field reports a message being drafted for it inside itself: the newest step's glyph and clock sit at its right
// edge, the whole report rides that mark's hover, and the placeholder (the caller's words) names who is writing. A list
// of steps under the field used to grow a row per model asked and vanish with the message, so whatever sat under it
// jumped as it was reached.

const props = defineProps<{
    placeholder: string;
    // Whose message is being drafted; undefined when none is (or the field is the user's alone).
    draft?: LandedMessageDraft | undefined;
    // Heads the report's hover: whose work the message is for.
    draftTitle?: string | undefined;
    // The field's name for a screen reader, where the placeholder says something else (a suggestion, a wait).
    label?: string | undefined;
}>();
const message = defineModel<string>({ required: true });
const emit = defineEmits<{ submit: [] }>();

const layout = useLayout();

// Ticks only while the draft runs, so its in-flight step's clock actually moves.
const clock = useNow(() => draftRunning(props.draft));
// The step list while a draft runs, and the post-mortem after it fails; a draft that succeeded clears from here, since
// its message is report enough.
const rows = computed<readonly DraftReportRow[]>(() => {
    const draft = props.draft;
    return draft === undefined || draft.outcome === `written` ? [] : draftReport(draft, clock.value);
});
const line = computed<DraftReportRow | undefined>(() => rows.value.at(-1));
// The mark's words for a screen reader, which gets neither its glyph nor its hover.
const spoken = computed<string>(() =>
    line.value === undefined ? `` : [line.value.model, line.value.detail, line.value.elapsed].filter((part) => part !== undefined).join(` `),
);
const tip = computed((): Tip | undefined =>
    rows.value.length === 0
        ? undefined
        : {
              title: props.draftTitle ?? ``,
              rows: rows.value.map((row) => ({
                  label: row.model ?? row.detail ?? ``,
                  value: [row.model === undefined ? undefined : row.detail, row.elapsed].filter((part) => part !== undefined).join(` · `),
                  tone: row.status === `failed` ? `warning` : undefined,
              })),
          },
);

// One glyph and colour per row status. A refusal mid-chain isn't an error (the fallback is working); only a draft that
// ends with nothing is amber.
const STEP_MARKS: Record<DraftReportRow[`status`], { icon: IconName; spin?: boolean; tone: string }> = {
    reading: { icon: `spinner`, spin: true, tone: `text-subtle` },
    asking: { icon: `spinner`, spin: true, tone: `text-link` },
    answered: { icon: `check`, tone: `text-success` },
    refused: { icon: `times`, tone: `text-subtle` },
    skipped: { icon: `forward`, tone: `text-subtle` },
    failed: { icon: `exclamation-triangle`, tone: `text-warning` },
};

// A textarea, not an input, since a message can carry a release-note trailer as a body. Measured via `scrollHeight`,
// not counted newlines — a single wrapped line is still one line to `split`. Eight lines at this box's font/padding,
// matching the composer's own ceiling (ChatPane), scaled to the sidebar.
const MAX_HEIGHT = 142;
const box = ref<HTMLTextAreaElement | null>(null);
// This box has its own border (the composer's doesn't), so growTextarea reads it off the element rather than a constant.
const grow = (): void => {
    growTextarea(box.value, MAX_HEIGHT);
};
// Watched, not `@input`: most of what fills this box isn't typing (a chip fill, a clear, a sandbox switch). Sidebar
// width, the placeholder and the mark are in the list too, since a re-wrap, a longer placeholder and the room the mark
// keeps at the field's edge all change the needed height.
watch([box, message, () => props.placeholder, layout.sidebarWidth, () => line.value !== undefined], grow, { flush: `post` });

defineExpose({ focus: (): void => box.value?.focus() });
</script>

<template>
    <div class="relative">
        <textarea
            ref="box"
            v-model="message"
            rows="1"
            :placeholder="placeholder"
            :aria-label="label"
            class="ui-field-box ui-field-sm block max-h-[142px] w-full min-w-0 resize-none overflow-y-auto leading-snug"
            :class="line ? `pr-18` : undefined"
            @keydown.ctrl.enter="emit(`submit`)"
            @keydown.meta.enter="emit(`submit`)"
        ></textarea>
        <span
            v-if="line"
            class="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1 whitespace-nowrap text-2xs"
            v-tooltip.right="tip"
            @click="box?.focus()"
        >
            <Icon :name="STEP_MARKS[line.status].icon" :spin="STEP_MARKS[line.status].spin" class="text-2xs" :class="STEP_MARKS[line.status].tone" />
            <span v-if="line.elapsed !== undefined" class="tabular-nums text-subtle" aria-hidden="true">{{ line.elapsed }}</span>
            <span class="sr-only">{{ spoken }}</span>
        </span>
    </div>
</template>
