<script setup lang="ts">
import { Segmented, useDevice } from "@intentic-app/ui";
import type { DiffLayout } from "../../../composables/useLayout";
import { useLayout } from "../../../composables/useLayout";
import DiffStat from "../../../components/DiffStat.vue";
import { type ChangeStatus, STATUS_CLASS, STATUS_LETTER } from "../workspaceTabs";

/* The bar above a diff — WHICH file, and HOW it is being read. Every diff surface in the app renders this one:
 * the workspace tab, the agent review, the environment card's proposal. Before it there was no such thing, and
 * the two halves of the job had drifted apart: the agent review grew a header with Split|Unified on it, the
 * workspace tab had no header at all (its layout was decided by the form factor and could not be changed), and
 * the comment toggle — which belongs to both — floated over the code in the top-right corner as a translucent
 * chip, on top of the minimap, because there was no bar anywhere to put it in. A control that hides over the
 * thing it modifies is a control most people never find; that is the whole reason this file exists.
 *
 * What it owns is exactly the READING settings, and both are global (useLayout), not per file or per surface:
 * how you like to read a diff is a habit, and having to re-pick Unified on every file — or discovering the app
 * had thrown the choice away by walking from the review to the workspace — is the surface leaking its own
 * component boundaries at the user. What it does NOT own is anything about the file's place in a review: the
 * viewed tick, the next-file arrows, the open-in-editor jump. Those differ per host and arrive through slots.
 *
 * Slots, in render order:
 *   lead    — before the path (the phone's back arrow out of a full-screen diff)
 *   badges  — after the path (a blocked/not-landed mark: a property of the FILE, so it rides with its name)
 *   actions — after the reading controls (the host's own file-scoped buttons) */

const { path, status, additions, deletions, from } = defineProps<{
    // Repo-qualified where the surface knows the repo — this is a label to read, not a key.
    path: string;
    status?: ChangeStatus;
    additions?: number;
    deletions?: number;
    // Where a rename came from, printed as `← old/path` on the surfaces that track renames.
    from?: string;
}>();

const { mobile } = useDevice();
const { showComments, toggleShowComments, diffLayout, setDiffLayout } = useLayout();

const basename = (value: string): string => value.slice(value.lastIndexOf(`/`) + 1);
const parentDir = (value: string): string => (value.includes(`/`) ? value.slice(0, value.lastIndexOf(`/`)) : ``);

// Two panes don't fit a phone, so the control is desktop-only and DiffView forces unified there — the stored
// preference is left alone rather than being overwritten by a form factor the user didn't choose.
const LAYOUT_OPTIONS: { label: string; value: DiffLayout }[] = [
    { label: `Split`, value: `split` },
    { label: `Unified`, value: `unified` },
];
</script>

<template>
    <div class="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2 max-md:h-12">
        <slot name="lead" />
        <span v-if="status !== undefined" class="w-3 shrink-0 text-center font-mono text-2xs" :class="STATUS_CLASS[status]">
            {{ STATUS_LETTER[status] }}
        </span>
        <!-- Directory dimmed and leading, basename legible — the same reading order the review's rows use, so
             the file you clicked on the left and the file named up here are recognisably the same thing. Only
             the DIRECTORY truncates: a bar that ellipsises the file name has printed the least useful half of
             the path, which is what a single `truncate` over the whole string does on any narrow column. -->
        <span class="flex min-w-0 flex-1 items-baseline text-2xs max-md:text-xs" v-tooltip.bottom.overflow="path">
            <span v-if="parentDir(path) !== ''" class="min-w-0 truncate text-subtle">{{ parentDir(path) }}/</span>
            <span class="shrink-0 font-medium text-content">{{ basename(path) }}</span>
        </span>
        <span
            v-if="from !== undefined"
            class="hidden max-w-40 truncate font-mono text-2xs text-subtle md:inline-block"
            v-tooltip.bottom="`renamed from ${from}`"
        >
            ← {{ from }}
        </span>
        <slot name="badges" />
        <DiffStat :additions="additions" :deletions="deletions" />
        <Segmented v-if="!mobile" :model-value="diffLayout" :options="LAYOUT_OPTIONS" size="xs" @update:model-value="setDiffLayout" />
        <!-- A default that silently removes lines has to keep saying so, which is why this is a labelled toggle
             and not one more glyph: "Comments" with an eye through it is readable at a glance as a state. -->
        <button
            type="button"
            class="flex shrink-0 items-center justify-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium text-muted transition-colors hover:bg-overlay hover:text-content max-md:h-9 max-md:w-9"
            :class="{ 'bg-primary-600/15 text-link': showComments }"
            :aria-pressed="showComments"
            v-tooltip.bottom="showComments ? 'Comments shown — click to diff the code alone' : 'Comments hidden — click to show them'"
            @click="toggleShowComments()"
        >
            <Icon class="text-2xs" :name="showComments ? `eye` : `eye-slash`" />
            <span class="max-md:hidden">Comments</span>
        </button>
        <slot name="actions" />
    </div>
</template>
