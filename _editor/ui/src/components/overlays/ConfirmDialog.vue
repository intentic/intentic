<!--
    The one confirm modal for every "are you sure?": Cancel plus a destructive (red, autofocused) button by default; `destructive: false` for a
    non-deletion commit that still can't be undone. `items` renders a truncated list ("…and N more") when the action names a set.
-->
<script setup lang="ts" generic="T">
import Button from "../primitives/Button.vue";
import type { IconName } from "../../icons/iconSets.js";
import Icon from "../primitives/Icon.vue";
import Modal from "./Modal.vue";

const {
    open,
    header,
    confirmLabel,
    confirmIcon,
    items,
    destructive = true,
    loading = false,
    size = `sm`,
    appendTo,
} = defineProps<{
    open: boolean;
    header: string;
    confirmLabel: string;
    confirmIcon?: IconName;
    /** The set being acted on. The first few render through `#item`; the rest become a count. */
    items?: readonly T[];
    /** False for a confirm that commits rather than destroys: see above. */
    destructive?: boolean;
    /** Keeps the danger button spinning while the teardown runs: removal often hits the network. */
    loading?: boolean;
    /** <Modal>'s size scale. `sm` fits a question; widen only for a confirm that has to spell out consequences. */
    size?: `sm` | `md` | `lg` | `xl` | `full`;
    appendTo?: HTMLElement | string;
}>();

/* `hide` fires once the modal has actually closed, by WHICHEVER road: Cancel, Esc, the mask, or a completed
 * confirm. It exists for focus restoration: a list that a keyboard was walking (the file explorer) has to take
 * the keyboard back when the dialog over it goes away, or the next keystroke lands on <body> and the user has
 * lost their place. Distinct from `cancel` on purpose: cancel is a DECISION, this is a lifecycle moment. */
const emit = defineEmits<{ cancel: []; confirm: []; hide: [] }>();

// Five, because it is the most a modal can name without becoming the list it is asking about.
const NAMED = 5;
</script>

<template>
    <Modal :open="open" :size="size" :append-to="appendTo" :header="header" @update:open="emit(`cancel`)" @hide="emit(`hide`)">
        <ul v-if="items !== undefined && items.length > 0" class="flex flex-col gap-1">
            <li v-for="(item, index) in items.slice(0, NAMED)" :key="index" class="flex min-w-0 items-center gap-2 text-sm">
                <slot name="item" :item="item" />
            </li>
            <li v-if="items.length > NAMED" class="text-xs text-subtle">…and {{ items.length - NAMED }} more</li>
        </ul>
        <slot />
        <template #footer>
            <Button label="Cancel" severity="secondary" :text="true" @click="emit(`cancel`)" />
            <!-- autofocus on the CONFIRM button is deliberate and is what the call sites already did: the
                 dialog is dismissable by mask, Esc and Cancel, so the keyboard's default should be the one
                 action the user came here to take. -->
            <Button :label="confirmLabel" :severity="destructive ? `danger` : undefined" autofocus :loading="loading" @click="emit(`confirm`)">
                <template v-if="confirmIcon !== undefined" #icon><Icon :name="confirmIcon" /></template>
            </Button>
        </template>
    </Modal>
</template>
