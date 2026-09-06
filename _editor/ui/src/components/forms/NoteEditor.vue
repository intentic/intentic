<!-- ONE MARKDOWN NOTE, read and curated: the frame two extensions had each built around <ScrollFrame>.

     WHAT IT OWNS is everything that is the same wherever a note is edited: the Copy/Edit/Delete cluster and the
     Cancel/Save pair that replaces it, the in-place delete confirmation, the error strip, the loading line, and
     the one surface the file is both READ and WRITTEN on. What it does not own is the note: the body, the
     badges, the meta line and any extra control are the caller's, because that is where two notes differ.

     READING AND WRITING ARE ONE SURFACE, and that is the rule every pane that came before got wrong. First
     they were two: a coloured block to read the markdown in and a bare grey <textarea> to change it in, so the
     file changed typeface, colour, leading and size at the moment you picked up the pen. Then they were one
     <CodeField>, which fixed the drift but settled it on the wrong side — the note read as SOURCE whether or
     not anybody was editing it, which is why the pane above this one had to grow a Read/Source pair to get the
     document back.

     Now it is <MarkdownDocument>: the note is the document in both states, and `editing` only decides whether
     a caret goes in it. That is what lets `showSource` go — there is no second view left for it to select,
     because the markup is in the surface the whole time and simply hidden until the caret enters a block.

     THE CONFIRMATION RIDES #strips rather than the body, so a long note cannot scroll the question away from the
     answer, and it is in place rather than in a <ConfirmDialog> because the sentence names the note you are
     looking at. `verb` is the whole of what differs between callers, and it spells the button, the tooltip and
     the accessible name from one word: "Delete" for a knowledge note, whose neighbours are left linking to
     something nobody has written, and whatever the removal actually means to the next pane that reuses it.

     `paged` IS WHICH SURFACE THE NOTE IS ON, and it is a real fork rather than a preference — the same fork
     <ScrollFrame> draws, forwarded, because a note is exactly the kind of thing that reads badly through a
     window. Bounded (`paged` off), the frame owns a scroller and the note reads through whatever is left of it
     after the header: measured on the knowledge section, 473px of a 648px pane, so a note of any length arrived
     as a 20-line slot with an invisible scrollbar, inside a page that had nothing to scroll. Paged, the page
     owns it: the note is as long as it is, the header pins itself instead of merely staying put, and the
     Cancel/Save pair pins with it, which is the part that stops being a nicety once a draft is five screens
     long. Nothing else moves, and #strips keeps its contract either way. -->
<script setup lang="ts">
import Button from "../primitives/Button.vue";
import { ui } from "../../lib/ui.js";
import CopyButton from "../primitives/CopyButton.vue";
import Icon from "../primitives/Icon.vue";
import MarkdownDocument from "../markdown/MarkdownDocument.vue";
import ScrollFrame from "../layout/ScrollFrame.vue";
import StatusBadge from "../feedback/StatusBadge.vue";

const { verb = `Delete`, paged = false } = defineProps<{
    /** The note's name, in the frame's header. */
    title: string;
    /** The file as it stands on disk: what Copy copies, whatever is on screen. */
    raw: string;
    /** Is a draft open. Swaps the action cluster, and puts a caret in the document. */
    editing: boolean;
    /** Nothing has arrived yet. Suppressed while editing: a draft is already on screen. */
    loading?: boolean;
    saving?: boolean;
    removing?: boolean;
    /** Whatever went wrong: the read or either write. */
    error?: string;
    /** What deleting this kind of note is CALLED. Spells the tooltip, the accessible name and the confirm
     *  button ("Forget", "Forget it", "Forget this note"). */
    verb?: string;
    /** The PAGE owns the scroll: the note runs its full length and the header pins itself. See the note above. */
    paged?: boolean;
}>();

const emit = defineEmits<{ edit: []; cancel: []; save: []; remove: [] }>();

/** The source surface's text. The caller binds its draft-or-file computed straight to this. */
const source = defineModel<string>(`source`, { required: true });
/** Whether the delete confirmation is showing: a model because this component's own trash button opens it. */
const confirming = defineModel<boolean>(`confirming`, { default: false });
</script>

<template>
    <!-- `grow` is for the bounded case only: `flex-1` in an auto-height parent resolves to nothing, and asking
         for it there is how a paged frame ends up collapsed instead of merely un-grown. -->
    <ScrollFrame :grow="!paged" :scroll="!paged" :sticky="paged" :title="title">
        <template v-if="$slots[`lead`]" #lead><slot name="lead" /></template>

        <!-- "Unsaved" is this component's, not the caller's: it is a fact about the draft it is holding, and a
             pane that had to remember to render it is a pane that will forget. -->
        <template #badges>
            <slot name="badges" />
            <StatusBadge v-if="editing" variant="warning" size="xs" label="unsaved" />
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
            <!-- THE NOTE, and while a draft is open it is the same note with a caret in it. `save="none"`
                 because this frame's Cancel/Save pair above IS the save policy — a second one inside the
                 document would put two Save buttons a centimetre apart. Ctrl/Cmd-S and Escape are bound here
                 because the caret is in this surface, and a save shortcut that only works once you have left
                 the thing you were typing in is not a save shortcut.

                 The caller's own rendering (its `#default` slot: a note's header facts, its connections, its
                 see-also) is what shows when nothing is being written, because a knowledge note is more than
                 its prose. A caller with nothing to add leaves the slot out and gets the document. -->
            <div
                v-if="editing"
                class="px-4 py-3"
                @keydown.ctrl.s.prevent="emit(`save`)"
                @keydown.meta.s.prevent="emit(`save`)"
                @keydown.esc="emit(`cancel`)"
            >
                <MarkdownDocument v-model="source" editable save="none" label="Note" placeholder="Write the note." />
            </div>
            <slot v-else>
                <MarkdownDocument :model-value="source" label="Note" class="px-4 py-3" />
            </slot>
        </template>
    </ScrollFrame>
</template>
