<!-- THE MODAL — the app's one centred, dismissable box, and the only thing that should reach for PrimeVue's
     Dialog. Everything a modal is asked to hold goes through here: a form, a confirm, a document, an embedded
     browser, a terminal's scrollback.

     IT EXISTS FOR THE WIDTH. Seventeen dialogs had each set their own, inline, as a style object: 22, 24, 26,
     28, 30, 32, 34, 36, 38, 44, 48, 64 and 80rem — thirteen answers to a question nobody was asking on
     purpose, because a width typed into a style attribute is a number you pick once and never compare to
     anything. That much is only untidy. What made it a bug is the SECOND half: a modal needs a viewport clamp
     or it runs off the side of a phone, and exactly ONE of the seventeen had one. Sixteen dialogs overflowed a
     360px screen, and none of the people who wrote them could have seen it, because the failure only exists at
     a width a desktop never renders.

     So the width is a NAMED SIZE and the clamp is not the caller's to remember — `--container-modal-*` carries
     both as one token (see tokens.css). Four sizes cover all seventeen call sites, and the band edges are
     where the old widths already clustered, so nothing moves more than 4rem. This is the same lesson
     <ConfirmDialog> learned for confirms alone and could not generalise, because it is a confirm and most
     dialogs are not; ConfirmDialog and InfoDialog are both built on this now.

     THE BODY SCROLLS BY DEFAULT, capped at `--height-panel-lg`. A modal that grows past the viewport puts its
     own footer off-screen — the buttons the user came for, gone, with the page behind it unable to scroll
     because the mask has it. Five call sites had discovered this and written the cap themselves (at 70dvh, in
     a `pt` block); the rest had simply never been opened with enough content. `scroll={false}` is for the
     dialog that lays out its own height instead (a scrollback viewer, an embedded browser), where a second
     scroller nested in the first is the bug rather than the fix.

     `chrome={false}` drops the header bar and the body's padding together, for the surface that is a floating
     COMMAND SURFACE rather than a document — the quick-open palette, whose own field is its header. The two
     always travel together, which is why it is one prop and not two.

     `open` is a v-model so a caller holding a plain boolean writes `v-model:open`, and a caller whose state is
     the thing being acted on (`pendingDiscard !== undefined`) binds `:open` and listens for `@update:open`,
     which is what all of them already did with `visible`. `@hide` fires once the box has actually gone, by
     whichever road — it is the focus-restoration moment, not a decision. -->
<script setup lang="ts">
import Dialog from "primevue/dialog";
import { computed } from "vue";

const {
    size = `md`,
    header,
    chrome = true,
    scroll = true,
    dismissable = true,
    position = `center`,
    appendTo,
} = defineProps<{
    /** `sm` a confirm or rename · `md` a form · `lg` a document · `xl` content that IS the width · `full` a canvas. */
    size?: `sm` | `md` | `lg` | `xl` | `full`;
    /** The title bar's text. Omit and supply `#header` to draw your own; ignored when `chrome` is false. */
    header?: string;
    /** False drops the header bar AND the body padding — the command-palette shape. */
    chrome?: boolean;
    /** False when the body lays out its own height and scrolls itself. */
    scroll?: boolean;
    /** False for a modal that must be dismissed by a real decision (an in-flight login). */
    dismissable?: boolean;
    /** `top` for a surface summoned by a keyboard shortcut, which should not make the eye travel. */
    position?: `center` | `top`;
    /** The popped-out window's overlay host, for a modal raised from a panel that is no longer in this one. */
    appendTo?: HTMLElement | string;
}>();

const open = defineModel<boolean>(`open`, { required: true });

/* `show` is the mounted-and-visible moment — the one a surface that has to put the keyboard somewhere needs
 * (the palette's field, a rename's input), because the box does not exist to focus until it fires. */
const emit = defineEmits<{ show: []; hide: [] }>();

const WIDTH: Record<string, string> = {
    sm: `w-modal-sm`,
    md: `w-modal`,
    lg: `w-modal-lg`,
    xl: `w-modal-xl`,
    full: `w-modal-full`,
};

/* `full` is the only size that claims a HEIGHT as well as a width, because it is the only one whose content is
 * a canvas: a graph told to fill its parent has nothing to fill unless someone up the tree has committed to a
 * number. The box takes `--height-panel-xl` and the body takes what the header leaves, so the canvas can
 * simply be `h-full`. Every other size is as tall as what is in it, which is what a form should be. */
const rootClass = computed(() => (size === `full` ? `${WIDTH[size]} h-panel-xl` : WIDTH[size]));

/* The three body treatments are decided together rather than at three call sites, because they interact: a
 * body that kept its padding after the header went away is the shape the palette had to override with `!p-0`
 * by hand, and a `full` body that also capped its own height would scroll inside a box already sized to hold
 * it. Order matters only in that the scroll cap must not be added when the box owns the height. */
const contentClass = computed(() =>
    [
        chrome ? `` : `!p-0 !overflow-hidden !rounded-lg`,
        size === `full` ? `!flex min-h-0 !flex-1 !flex-col` : ``,
        scroll ? `max-h-panel-lg overflow-y-auto` : ``,
    ]
        .filter(Boolean)
        .join(` `),
);
</script>

<template>
    <Dialog
        v-model:visible="open"
        :modal="true"
        :draggable="false"
        :dismissable-mask="dismissable"
        :close-on-escape="dismissable"
        :show-header="chrome"
        :header="header"
        :position="position"
        :append-to="appendTo"
        :class="rootClass"
        :pt="{ content: { class: contentClass }, footer: { class: `flex flex-wrap justify-end gap-2` } }"
        @show="emit(`show`)"
        @hide="emit(`hide`)"
    >
        <template v-if="$slots[`header`]" #header><slot name="header" /></template>
        <slot />
        <template v-if="$slots[`footer`]" #footer><slot name="footer" /></template>
    </Dialog>
</template>
