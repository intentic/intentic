<!--
    One markdown note, read and edited on a single <MarkdownDocument> surface, never a separate read/write view, framed with a Copy/Edit/Delete
    cluster and an in-place delete confirmation. `verb` names the delete action; `paged` forwards to <ScrollFrame>'s bounded/full-page fork.
-->
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
    /** What deleting this kind of note is called; spells the tooltip, accessible name and confirm button text. */
    verb?: string;
    /** The page owns the scroll: the note runs full length and the header pins itself. */
    paged?: boolean;
}>();

const emit = defineEmits<{ edit: []; cancel: []; save: []; remove: [] }>();

/** The source surface's text. The caller binds its draft-or-file computed straight to this. */
const source = defineModel<string>(`source`, { required: true });
/** Whether the delete confirmation is showing: a model because this component's own trash button opens it. */
const confirming = defineModel<boolean>(`confirming`, { default: false });
</script>

<template>
    <!-- `grow` only applies when bounded; `flex-1` resolves to nothing in an auto-height parent, collapsing it. -->
    <ScrollFrame :grow="!paged" :scroll="!paged" :sticky="paged" :title="title">
        <template v-if="$slots[`lead`]" #lead><slot name="lead" /></template>

        <!-- "Unsaved" is this component's own badge, a fact about the draft it holds, not something callers render. -->
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
            <!--
                Caller's own controls sit before Copy, shown only while reading; editing replaces everything to their
                right.
            -->
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
            <!--
                `save="none"`: this frame's Cancel/Save pair is the save policy, so the document must not offer its
                own. Ctrl/Cmd-S and Escape are bound here since the caret lives in this surface; the `#default` slot
                shows instead when not editing.
            -->
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
