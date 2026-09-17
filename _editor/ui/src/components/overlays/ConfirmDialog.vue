<!-- Confirm modal: Cancel plus an autofocused destructive action by default. -->
<script setup lang="ts" generic="T">
import { useId } from "vue";
import Button from "../primitives/Button.vue";
import type { IconName } from "../../icons/iconSets.js";
import { useT } from "../../i18n/index.js";
import Icon from "../primitives/Icon.vue";
import Modal from "./Modal.vue";

const t = useT();

const {
    open,
    header,
    headerIcon,
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
    /** A glyph beside the title; tinted by `destructive`, so it never reads as safe on a confirm that destroys. */
    headerIcon?: IconName;
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

/* `hide` fires once the modal has actually closed, by WHICHEVER road: Cancel, Esc, the mask, or a completed confirm. */
const emit = defineEmits<{ cancel: []; confirm: []; hide: [] }>();

// Five, because it is the most a modal can name without becoming the list it is asking about.
const NAMED = 5;

// Drawing our own header drops PrimeVue's titled span, so the name the dialog is announced by has to be re-pointed.
const titleId = useId();
</script>

<template>
    <Modal
        :open="open"
        :size="size"
        :append-to="appendTo"
        :header="header"
        :labelled-by="headerIcon === undefined ? undefined : titleId"
        @update:open="emit(`cancel`)"
        @hide="emit(`hide`)"
    >
        <template v-if="headerIcon !== undefined" #header="{ titleClass }">
            <div class="flex min-w-0 items-center gap-3">
                <span
                    class="grid size-9 shrink-0 place-items-center rounded-full"
                    :class="destructive ? `bg-danger/10 text-danger` : `bg-primary-600/15 text-primary-500`"
                >
                    <Icon :name="headerIcon" />
                </span>
                <span :id="titleId" :class="titleClass">{{ header }}</span>
            </div>
        </template>
        <ul v-if="items !== undefined && items.length > 0" class="flex flex-col gap-1">
            <li v-for="(item, index) in items.slice(0, NAMED)" :key="index" class="flex min-w-0 items-center gap-2 text-sm">
                <slot name="item" :item="item" />
            </li>
            <li v-if="items.length > NAMED" class="text-xs text-subtle">…and {{ items.length - NAMED }} more</li>
        </ul>
        <slot />
        <template #footer>
            <Button :label="t(`ui.action.cancel`)" severity="secondary" :text="true" @click="emit(`cancel`)" />
            <!-- autofocus on the CONFIRM button is deliberate and is what the call sites already did: the dialog is dismissable by mask, Esc and Cancel. -->
            <Button :label="confirmLabel" :severity="destructive ? `danger` : undefined" autofocus :loading="loading" @click="emit(`confirm`)">
                <template v-if="confirmIcon !== undefined" #icon><Icon :name="confirmIcon" /></template>
            </Button>
        </template>
    </Modal>
</template>
