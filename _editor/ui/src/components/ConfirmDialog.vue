<!-- THE CONFIRM, one modal for every "are you sure?" in the app: discarding unsaved tabs, killing running
     terminals, deleting files, removing a capability or an automation, leaving a sandbox.

     DESTRUCTIVE IS THE DEFAULT, because deleting something is what nearly every confirm in this app is about,
     and a confirm that has to declare its own tone is a confirm that will be declared wrong. `destructive`
     turns off only the red: the second thing worth stopping for is a commit that CANNOT BE TAKEN BACK
     without being a deletion (approving a queue of posts to the public internet), and painting that button
     danger-red says "this deletes something", which is the one thing it does not do.

     Nine call sites had written this out, and what they agreed on was everything that matters: the same four
     Dialog props, the same Cancel-then-danger footer, the same `autofocus` on the destructive button. What
     they had drifted on was the width: 24rem, 26rem, and one call site that had noticed a bare `26rem` dialog
     overflows a 360px phone and clamped it. That clamp is now the only behaviour, because it was right and the
     other eight were one narrow screen away from finding out. It is <Modal>'s clamp now rather than this
     component's own: the same reasoning had to be repeated for every dialog that is not a confirm, and
     repeating it once per shape is how thirteen widths happened.

     THE LIST IS PART OF THE CONFIRM, not decoration. Three of the sites were about a SET: five files, three
     terminals, and each had written the same "show five, then `…and N more`" truncation. A confirm that says
     "delete 40 files?" without naming any is asking the user to trust a number they cannot check; naming five
     and counting the rest is the compromise that fits in a modal. Pass `items` and render one with `#item`;
     the default slot is the prose underneath, which is where the consequence goes ("This can't be undone").

     Cancel is `@cancel` rather than a `v-model`, because the call sites hold state of every shape: a payload,
     a path set, a plain boolean, and none of them wants this component deciding what "closed" means for it. -->
<script setup lang="ts" generic="T">
import Button from "./Button.vue";
import { type IconName } from "../icons/iconSets.js";
import Icon from "./Icon.vue";
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
