<!-- One markdown note, read and edited on a single <MarkdownDocument> surface, never a separate read/write view. -->
<script setup lang="ts">
import Button from "../primitives/Button.vue";
import { useT } from "../../i18n/index.js";
import { ui } from "../../lib/ui.js";
import CopyButton from "../primitives/CopyButton.vue";
import Icon from "../primitives/Icon.vue";
import MarkdownDocument from "../markdown/MarkdownDocument.vue";
import ScrollFrame from "../layout/ScrollFrame.vue";
import StatusBadge from "../feedback/StatusBadge.vue";

const { verb, paged = false } = defineProps<{
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

const t = useT();
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
            <StatusBadge v-if="editing" variant="warning" size="xs" :label="t(`ui.noteEditor.unsaved`)" />
        </template>

        <template v-if="$slots[`description`]" #description><slot name="description" /></template>
        <template v-if="$slots[`meta`]" #meta><slot name="meta" /></template>

        <template #actions>
            <template v-if="editing">
                <Button :label="t(`ui.action.cancel`)" size="small" severity="secondary" @click="emit(`cancel`)" />
                <Button :label="t(`ui.action.save`)" size="small" :loading="saving" @click="emit(`save`)">
                    <template #icon><Icon name="save" /></template>
                </Button>
            </template>
            <!-- Caller's own controls sit before Copy, shown only while reading; editing replaces everything to their right. -->
            <template v-else>
                <slot name="actions" />
                <CopyButton :text="raw" v-tooltip.top="t(`ui.noteEditor.copyRawNote`)" />
                <button
                    type="button"
                    :class="ui.iconButton(`h-7 w-7`)"
                    :aria-label="t(`ui.noteEditor.editNote`)"
                    v-tooltip.top="t(`ui.action.edit`)"
                    @click="emit(`edit`)"
                >
                    <Icon name="pencil" />
                </button>
                <button
                    type="button"
                    :class="ui.iconButton(`h-7 w-7 hover:bg-danger/10 hover:text-danger`)"
                    :aria-label="t(`ui.noteEditor.note`, { verb: verb ?? t(`ui.action.delete`) })"
                    v-tooltip.top="verb ?? t(`ui.action.delete`)"
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
                    <Button :label="t(`ui.noteEditor.keep`)" size="small" severity="secondary" @click="confirming = false" />
                    <Button
                        :label="t(`ui.noteEditor.it`, { verb: verb ?? t(`ui.action.delete`) })"
                        size="small"
                        severity="danger"
                        :loading="removing"
                        @click="emit(`remove`)"
                    />
                </div>
            </div>
            <div v-if="error" class="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">{{ error }}</div>
        </template>

        <p v-if="loading && !editing" class="px-4 py-6 text-xs text-subtle">{{ t(`ui.status.loading`) }}</p>
        <template v-else>
            <!-- `save="none"`: this frame's Cancel/Save pair is the save policy, so the document must not offer its own. -->
            <div
                v-if="editing"
                class="px-4 py-3"
                @keydown.ctrl.s.prevent="emit(`save`)"
                @keydown.meta.s.prevent="emit(`save`)"
                @keydown.esc="emit(`cancel`)"
            >
                <MarkdownDocument
                    v-model="source"
                    editable
                    save="none"
                    :label="t(`ui.noteEditor.note2`)"
                    :placeholder="t(`ui.noteEditor.writeNote`)"
                />
            </div>
            <slot v-else>
                <MarkdownDocument :model-value="source" :label="t(`ui.noteEditor.note2`)" class="px-4 py-3" />
            </slot>
        </template>
    </ScrollFrame>
</template>
