<!-- ONE MARKDOWN NOTE, read and curated: the frame two extensions had each built around <ScrollFrame>.

     WHAT IT OWNS is everything that is the same wherever a note is edited: the Copy/Edit/Delete cluster and the
     Cancel/Save pair that replaces it, the in-place delete confirmation, the error strip, the loading line, and
     the one surface the file is both READ and WRITTEN on. What it does not own is the note: the body, the
     badges, the meta line and any extra control are the caller's, because that is where two notes differ.

     SOURCE AND EDIT ARE ONE SURFACE (<CodeField>, `readonly` or not): the memory pane's rule, and its reason.
     They used to be two there: a coloured block to read the markdown in and a bare grey <textarea> to change it
     in. So the file changed typeface, colour, leading and size at the moment you picked up the pen, and the
     textarea's `h-full min-h-64` in a panel with no height to be full OF also shrank it to seven visible lines.
     One surface cannot drift from itself. Hoisting it here is what keeps that true for the next pane as well.

     THE CONFIRMATION RIDES #strips rather than the body, so a long note cannot scroll the question away from the
     answer, and it is in place rather than in a <ConfirmDialog> because the sentence names the note you are
     looking at. `verb` is the whole of what differs between callers: "Delete" for a knowledge note, whose
     neighbours are left linking to something nobody has written, "Forget" for a memory note, which the agent
     stops recalling, and it spells the button, the tooltip and the accessible name from one word. -->
<script setup lang="ts">
import Button from "primevue/button";
import { ui } from "../lib/ui.js";
import CodeField from "./CodeField.vue";
import CopyButton from "./CopyButton.vue";
import Icon from "./Icon.vue";
import ScrollFrame from "./ScrollFrame.vue";
import StatusBadge from "./StatusBadge.vue";

const { verb = `Delete` } = defineProps<{
    /** The note's name, in the frame's header. */
    title: string;
    /** The file as it stands on disk: what Copy copies, whatever is on screen. */
    raw: string;
    /** Is a draft open. Swaps the action cluster, and forces the source surface whatever `showSource` says. */
    editing: boolean;
    /** The caller's view mode says "show me the file": the same surface, read-only. */
    showSource?: boolean;
    /** Nothing has arrived yet. Suppressed while editing: a draft is already on screen. */
    loading?: boolean;
    saving?: boolean;
    removing?: boolean;
    /** Whatever went wrong: the read or either write. */
    error?: string;
    /** What deleting this kind of note is CALLED. Spells the tooltip, the accessible name and the confirm
     *  button ("Forget", "Forget it", "Forget this note"). */
    verb?: string;
}>();

const emit = defineEmits<{ edit: []; cancel: []; save: []; remove: [] }>();

/** The source surface's text. The caller binds its draft-or-file computed straight to this. */
const source = defineModel<string>(`source`, { required: true });
/** Whether the delete confirmation is showing: a model because this component's own trash button opens it. */
const confirming = defineModel<boolean>(`confirming`, { default: false });
</script>

<template>
    <ScrollFrame grow :title="title">
        <template v-if="$slots[`lead`]" #lead><slot name="lead" /></template>

        <!-- "Unsaved" is this component's, not the caller's: it is a fact about the draft it is holding, and a
             pane that had to remember to render it is a pane that will forget. -->
        <template #badges>
            <slot name="badges" />
            <StatusBadge v-if="editing" variant="warning" size="xs" label="Unsaved" />
        </template>

        <template v-if="$slots[`description`]" #description><slot name="description" /></template>
        <template v-if="$slots[`meta`]" #meta><slot name="meta" /></template>

        <template #actions>
            <template v-if="editing">
                <Button label="Cancel" size="small" severity="secondary" @click="emit(`cancel`)" />
                <Button label="Save" size="small" :loading="saving" @click="emit(`save`)">
                    <template #icon><Icon name="save" /></template>
                </Button>
            </template>
            <!-- The caller's own controls sit BEFORE Copy and only while reading: they are about the note, and
                 an editor open over it has already replaced everything to their right. -->
            <template v-else>
                <slot name="actions" />
                <CopyButton :text="raw" v-tooltip.top="'Copy the raw note'" />
                <button type="button" :class="ui.iconButton(`h-7 w-7`)" aria-label="Edit this note" v-tooltip.top="'Edit'" @click="emit(`edit`)">
                    <Icon name="pencil" />
                </button>
                <button
                    type="button"
                    :class="ui.iconButton(`h-7 w-7 hover:bg-danger/10 hover:text-danger`)"
                    :aria-label="`${verb} this note`"
                    v-tooltip.top="verb"
                    @click="confirming = true"
                >
                    <Icon name="trash" />
                </button>
            </template>
        </template>

        <template #strips>
            <slot v-if="!editing" name="strips" />
            <div v-if="confirming" class="flex flex-wrap items-center justify-between gap-2 border-b border-danger/30 bg-danger/10 px-4 py-2.5">
                <span class="text-xs text-danger"><slot name="confirm" /></span>
                <div class="flex shrink-0 items-center gap-1.5">
                    <Button label="Keep it" size="small" severity="secondary" @click="confirming = false" />
                    <Button :label="`${verb} it`" size="small" severity="danger" :loading="removing" @click="emit(`remove`)" />
                </div>
            </div>
            <div v-if="error" class="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">{{ error }}</div>
        </template>

        <p v-if="loading && !editing" class="px-4 py-6 text-xs text-subtle">Loading…</p>
        <template v-else>
            <!-- The whole file, in markdown's own colours: read with `readonly`, written without it. Ctrl/Cmd-S
                 and Escape are bound here because the caret is in this field, and a save shortcut that only works
                 when the field has been left is not a save shortcut. -->
            <CodeField
                v-if="editing || showSource"
                v-model="source"
                lang="markdown"
                :readonly="!editing"
                aria-label="Note source"
                @keydown.ctrl.s.prevent="emit(`save`)"
                @keydown.meta.s.prevent="emit(`save`)"
                @keydown.esc="emit(`cancel`)"
            />
            <slot v-else />
        </template>
    </ScrollFrame>
</template>
