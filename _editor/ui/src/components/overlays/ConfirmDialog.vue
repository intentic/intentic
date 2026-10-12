<!-- Confirm modal: the question as its title, what it will do as its description, then Cancel and an autofocused confirm (destructive by default). -->
<script setup lang="ts" generic="T">
import Button from "../primitives/Button.vue";
import type { ButtonTone } from "../primitives/button.js";
import type { IconName } from "../../icons/iconSets.js";
import { useT } from "../../i18n/index.js";
import { toneWash } from "../../lib/tone.js";
import Icon from "../primitives/Icon.vue";
import Modal from "./Modal.vue";

const t = useT();

const {
    open,
    header,
    description,
    headerIcon,
    confirmLabel,
    confirmIcon,
    confirmDisabled = false,
    items,
    destructive = true,
    tone,
    gilded = false,
    loading = false,
    size = `sm`,
    appendTo,
} = defineProps<{
    open: boolean;
    /** The question, asked as the reader would answer it: "Delete this session?" */
    header: string;
    /** What saying yes does, and what it costs ("Its messages go too. This can't be undone."): announced with the
     *  question, so the body is left for what is being acted on. `#description` for one that needs markup. */
    description?: string;
    /** A glyph beside the title; tinted by `destructive`, so it never reads as safe on a confirm that destroys. */
    headerIcon?: IconName;
    confirmLabel: string;
    confirmIcon?: IconName;
    /** Holds the confirm until the body has what it needs (a name typed, a box ticked). */
    confirmDisabled?: boolean;
    /** The set being acted on. The first few render through `#item`; the rest become a count. */
    items?: readonly T[];
    /** False for a confirm that commits rather than destroys: see above. */
    destructive?: boolean;
    /** The confirm's colour when it is neither destroying nor plainly committing: `warning` for a step that skips a
     *  check, `success` for one that finishes something. Overrides what `destructive` would pick. */
    tone?: ButtonTone;
    /** The confirm of a gold button (`ui-button-gilded`, the update card's), cast in the same metal so the step that
     * takes it reads as the same one. Never with `destructive`. */
    gilded?: boolean;
    /** Keeps the danger button spinning while the teardown runs: removal often hits the network. */
    loading?: boolean;
    /** <Modal>'s size scale. `sm` fits a question; widen only for a confirm that has to spell out consequences. */
    size?: `sm` | `md` | `lg` | `xl` | `full`;
    appendTo?: HTMLElement | string;
}>();

/* `hide` fires once the modal has actually closed, by WHICHEVER road: Cancel, Esc, the mask, or a completed confirm. */
const emit = defineEmits<{ cancel: []; confirm: []; hide: [] }>();

// Five, because it is the most a modal can name without becoming the list it is asking about.
const NAMED = 5;
</script>

<template>
    <Modal
        class="ui-dialog-confirm"
        :open="open"
        :size="size"
        :append-to="appendTo"
        :header="header"
        :description="description"
        @update:open="emit(`cancel`)"
        @hide="emit(`hide`)"
    >
        <template v-if="headerIcon !== undefined" #icon>
            <span :class="toneWash(destructive ? `danger` : `primary`, `grid size-9 place-items-center rounded-full`)">
                <Icon :name="headerIcon" />
            </span>
        </template>
        <template v-if="$slots[`description`]" #description><slot name="description" /></template>
        <!-- What the answer acts on, between the words that ask and the buttons that answer: a plain list on the dialog's own
             ground, since a frame round it would be a card on a card. -->
        <ul v-if="items !== undefined && items.length > 0" class="flex flex-col gap-1.5">
            <li v-for="(item, index) in items.slice(0, NAMED)" :key="index" class="flex min-w-0 items-center gap-2">
                <slot name="item" :item="item" />
            </li>
            <li v-if="items.length > NAMED" class="text-xs text-subtle">{{ t(`ui.confirmDialog.more`, { count: items.length - NAMED }) }}</li>
        </ul>
        <slot />
        <template #footer>
            <Button :label="t(`ui.action.cancel`)" tier="quiet" @click="emit(`cancel`)" />
            <!-- A second way to go ahead (do it later, say), drawn a tier below the confirm it sits beside. -->
            <slot name="actions" />
            <!-- autofocus on the CONFIRM button is deliberate and is what the call sites already did: the dialog is dismissable by mask, Esc and Cancel. -->
            <Button
                :label="confirmLabel"
                :tone="tone ?? (destructive ? `danger` : undefined)"
                :gilded="gilded && !destructive"
                autofocus
                :disabled="confirmDisabled"
                :loading="loading"
                @click="emit(`confirm`)"
            >
                <template v-if="confirmIcon !== undefined" #icon><Icon :name="confirmIcon" /></template>
            </Button>
        </template>
    </Modal>
</template>
