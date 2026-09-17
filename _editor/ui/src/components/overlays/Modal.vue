<!-- The app's one centred, dismissable box; forms, confirms and documents are all built on it. -->
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
    labelledBy,
    appendTo,
} = defineProps<{
    /** `sm` a confirm or rename · `md` a form · `lg` a document · `xl` content that IS the width · `full` a canvas. */
    size?: `sm` | `md` | `lg` | `xl` | `full`;
    /** The title bar's text. Omit and supply `#header` to draw your own; ignored when `chrome` is false. */
    header?: string;
    /** False drops the header bar and the body padding: the command-palette shape. */
    chrome?: boolean;
    /** False when the body lays out its own height and scrolls itself. */
    scroll?: boolean;
    /** False for a modal that must be dismissed by a real decision (an in-flight login). */
    dismissable?: boolean;
    /** `top` for a surface opened by a keyboard shortcut, so the eye doesn't have to travel to it. */
    position?: `center` | `top`;
    /** Id of the element naming this box. Required with `#header`: the title it replaces is what `aria-labelledby` points at. */
    labelledBy?: string;
    /** The overlay host, for a modal raised from a panel in a different (popped-out) window. */
    appendTo?: HTMLElement | string;
}>();

const open = defineModel<boolean>(`open`, { required: true });

// `show` fires once the box is mounted and visible, the first moment a surface that must put the
// keyboard somewhere (the palette's field, a rename's input) can focus it.
const emit = defineEmits<{ show: []; hide: [] }>();

const WIDTH: Record<string, string> = {
    sm: `w-modal-sm`,
    md: `w-modal`,
    lg: `w-modal-lg`,
    xl: `w-modal-xl`,
    full: `w-modal-full`,
};

// Only `full` claims a height too: a canvas needs a committed height to fill; other sizes size to content.
const rootClass = computed(() => (size === `full` ? `${WIDTH[size]} h-panel-xl` : WIDTH[size]));

// The three body treatments interact (padding, full's flex sizing, scroll cap), so they're set together here.
const contentClass = computed(() =>
    [
        chrome ? `` : `!p-0 !overflow-hidden !rounded-lg`,
        size === `full` ? `!flex min-h-0 !flex-1 !flex-col` : ``,
        // 72dvh AND what the viewport has left after this box's own header, footer and padding (10rem): the
        // percentage alone exceeds the viewport under ~570px, where the surplus is clipped, not scrolled.
        scroll ? `max-h-[min(var(--height-panel-lg),calc(100dvh_-_10rem))] overflow-y-auto` : ``,
    ]
        .filter(Boolean)
        .join(` `),
);

// `root` last: PrimeVue merges pt over its own `aria-labelledby`, which is the only way to re-point it at a `#header`.
const pt = computed(() => ({
    content: { class: contentClass.value },
    footer: { class: `flex flex-wrap justify-end gap-2` },
    ...(labelledBy === undefined ? {} : { root: { "aria-labelledby": labelledBy } }),
}));
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
        :pt="pt"
        @show="emit(`show`)"
        @hide="emit(`hide`)"
    >
        <!-- The title's own class, handed on so slot content wears its typography; PrimeVue's naming stops here, not at callers. -->
        <template v-if="$slots[`header`]" #header><slot name="header" title-class="p-dialog-title" /></template>
        <slot />
        <template v-if="$slots[`footer`]" #footer><slot name="footer" /></template>
    </Dialog>
</template>
