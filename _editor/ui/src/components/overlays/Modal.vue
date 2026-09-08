<!--
    The app's one centred, dismissable box; forms, confirms and documents are all built on it. `size` picks a named width tier
    (`--container-modal-*`) with its own viewport clamp. Body scrolls by default, capped at `--height-panel-lg`; `scroll={false}` and
    `chrome={false}` suit a caller that lays out its own height or header.
-->
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
    /** False drops the header bar and the body padding: the command-palette shape. */
    chrome?: boolean;
    /** False when the body lays out its own height and scrolls itself. */
    scroll?: boolean;
    /** False for a modal that must be dismissed by a real decision (an in-flight login). */
    dismissable?: boolean;
    /** `top` for a surface opened by a keyboard shortcut, so the eye doesn't have to travel to it. */
    position?: `center` | `top`;
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
