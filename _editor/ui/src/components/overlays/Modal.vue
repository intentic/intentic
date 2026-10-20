<!-- The app's one centred, dismissable box; forms, confirms and documents are all built on it. Its anatomy and why is dialog.css. -->
<script setup lang="ts">
import Dialog from "primevue/dialog";
import { computed, nextTick, ref, useId, useSlots, type VNode } from "vue";
import { useBackDismiss } from "../../composables/useBackDismiss.js";
import { useDevice } from "../../composables/useDevice.js";
import { provideSurfaceGround } from "./surfaceGround.js";

const {
    size = `md`,
    header,
    description,
    chrome = true,
    scroll = true,
    dismissable = true,
    position = `center`,
    labelledBy,
    appendTo,
} = defineProps<{
    /** `sm` a confirm or rename · `md` a form · `lg` a document · `xl` content that IS the width · `full` a canvas. */
    size?: `sm` | `md` | `lg` | `xl` | `full`;
    /** The title: the question the dialog asks, or the thing it is about. `#header` replaces it with markup of its own. */
    header?: string;
    /** A sentence or two under the title: what this is for, or what the action will do. Announced with the title, so
     *  the body below it holds only what the reader acts on. `#description` for one that needs markup. */
    description?: string;
    /** False drops the header bar and the body padding: the command-palette shape. */
    chrome?: boolean;
    /** False when the body lays out its own height and scrolls itself. */
    scroll?: boolean;
    /** False for a modal that must be dismissed by a real decision (an in-flight login). */
    dismissable?: boolean;
    /** `top` for a surface opened by a keyboard shortcut, so the eye doesn't have to travel to it. */
    position?: `center` | `top`;
    /** Id of the element naming this box, for a `#header` that names it some other way than its `titleId`. */
    labelledBy?: string;
    /** The overlay host, for a modal raised from a panel in a different (popped-out) window. */
    appendTo?: HTMLElement | string;
}>();

const open = defineModel<boolean>(`open`, { required: true });

// `show` fires once the box is mounted and visible, the first moment a surface that must put the
// keyboard somewhere (the palette's field, a rename's input) can focus it.
const emit = defineEmits<{ show: []; hide: [] }>();

const slots = useSlots();
// Everything in the box lies on it: no group or card inside draws a surface of its own (surfaceGround.ts).
provideSurfaceGround();
const { mobile, keyboardInset } = useDevice();

const titleId = useId();
const descriptionId = useId();
// Read while rendering, never cached: a slot a caller adds or drops between renders (a description that only shows once
// something has loaded) is not reactive state a computed could follow.
const describedNow = (): boolean => chrome && (description !== undefined || slots[`description`] !== undefined);
const labelNow = (): string | undefined => labelledBy ?? (header !== undefined || slots[`header`] !== undefined ? titleId : undefined);

// ON A PHONE A CENTRED BOX IS A SHEET ON THE BOTTOM EDGE (dialog.css). Not the palette: pinned to the top, it stays clear
// of the keyboard its field raises.
const sheet = computed(() => mobile.value && position === `center`);

// Back closes it there, as it closes every other sheet; only when nothing has to be decided first.
const backClosable = computed({
    get: () => open.value && dismissable && mobile.value,
    set: (value: boolean) => {
        if (!value) {
            open.value = false;
        }
    },
});
useBackDismiss(backClosable);

const WIDTH: Record<string, string> = {
    sm: `w-modal-sm`,
    md: `w-modal`,
    lg: `w-modal-lg`,
    xl: `w-modal-xl`,
    full: `w-modal-full`,
};

// Only `full` claims a height too: a canvas needs a committed height to fill; other sizes size to content.
const rootClass = computed(() => [sheet.value ? `ui-dialog-sheet` : WIDTH[size], size === `full` ? `h-panel-xl` : ``].filter(Boolean).join(` `));

// The three body treatments interact (padding, full's flex sizing, scroll cap), so they're set together here.
const contentClass = computed(() =>
    [
        chrome ? `` : `!p-0 !overflow-hidden rounded-[inherit]`,
        size === `full` ? `!flex min-h-0 !flex-1 !flex-col` : ``,
        // 72dvh AND what the viewport has left after this box's own header, footer and padding (10rem): the
        // percentage alone exceeds the viewport under ~570px, where the surplus is clipped, not scrolled.
        scroll ? `max-h-[min(var(--height-panel-lg),calc(100dvh_-_10rem))] overflow-y-auto` : ``,
    ]
        .filter(Boolean)
        .join(` `),
);

// THE EDGES A SCROLL SHOWS: whether the body has scrolled off its top, and whether more of it waits below. Measured on
// every scroll and every change of size, its own (the window) or its content's (a list that loaded, a fold opened).
const scrolled = ref(false);
const more = ref(false);
// The box, handed over by the element itself as it mounts (a vnode hook, merged beside PrimeVue's own ref rather than
// replacing it), so it is found in whichever window it was raised into.
let box: HTMLElement | undefined;
const held = (vnode: VNode<HTMLElement, HTMLElement>): void => {
    box = vnode.el ?? undefined;
};
const dropped = (): void => {
    box = undefined;
};
let body: HTMLElement | undefined;
let sized: ResizeObserver | undefined;
let grown: MutationObserver | undefined;

const measure = (): void => {
    if (body === undefined) {
        return;
    }
    scrolled.value = body.scrollTop > 0;
    more.value = Math.ceil(body.scrollTop + body.clientHeight) < body.scrollHeight;
};

const watchEdges = (): void => {
    body = box?.querySelector<HTMLElement>(`:scope > .p-dialog-content`) ?? undefined;
    if (body === undefined || !scroll) {
        return;
    }
    const view = body.ownerDocument.defaultView ?? window;
    body.addEventListener(`scroll`, measure, { passive: true });
    sized = new view.ResizeObserver(measure);
    const observeAll = (): void => {
        sized?.disconnect();
        if (body === undefined) {
            return;
        }
        sized?.observe(body);
        for (const child of Array.from(body.children)) {
            sized?.observe(child);
        }
    };
    observeAll();
    grown = new view.MutationObserver(() => {
        observeAll();
        measure();
    });
    grown.observe(body, { childList: true });
    measure();
};

const unwatchEdges = (): void => {
    body?.removeEventListener(`scroll`, measure);
    sized?.disconnect();
    grown?.disconnect();
    sized = undefined;
    grown = undefined;
    body = undefined;
    scrolled.value = false;
    more.value = false;
};

// WHERE THE KEYBOARD LANDS. PrimeVue focuses an `[autofocus]` inside and otherwise the ×, and either way forces the focus
// ring on: a ring round the × on every dialog opened with the mouse, the loudest thing in the box and the one control
// nobody came for. With nothing asking for focus the box itself takes it (no ring, and Tab goes on to the first
// control); a button that asked keeps it, with the ring left to the browser, which draws one for the keyboard only.
// A field keeps its ring: it says where typing goes.
const settleFocus = (): void => {
    if (box === undefined) {
        return;
    }
    // The box's own window's HTMLElement: a dialog raised into a popped-out window lives in another realm.
    const active = box.ownerDocument.activeElement;
    if (!(active instanceof (box.ownerDocument.defaultView ?? window).HTMLElement) || !box.contains(active)) {
        return;
    }
    if (active.matches(`.p-dialog-close-button`)) {
        box.focus({ preventScroll: true });
    } else if (!active.matches(`input, textarea, select, [contenteditable]`)) {
        active.blur();
        active.focus({ preventScroll: true });
    }
};

const onShow = (): void => {
    watchEdges();
    emit(`show`);
    // PrimeVue waits until the entrance animation ends to move focus. A quick Tab must already stay in the box.
    // The next tick lets PrimeVue remember the opener and lets a caller's show handler focus its own field first.
    void nextTick(() => {
        if (open.value && box !== undefined && !box.contains(box.ownerDocument.activeElement)) {
            box.focus({ preventScroll: true });
        }
    });
};

const onHide = (): void => {
    unwatchEdges();
    emit(`hide`);
};

// An attribute that is `undefined` is left off the element, and a `style` merges with the inline one PrimeVue lays out
// the box with. The two aria names are attributes on <Dialog> in the template instead: PrimeVue lays a component's own
// attributes over its `aria-labelledby` the way it lays pt, and there they are read on every render.
const rootAttrs = computed(() => ({
    tabindex: -1,
    onVnodeMounted: held,
    onVnodeUnmounted: dropped,
    "data-scrolled": scrolled.value ? `` : undefined,
    "data-more": more.value ? `` : undefined,
    style: sheet.value && keyboardInset.value > 0 ? { "--ui-sheet-lift": `${keyboardInset.value}px` } : undefined,
}));

const pt = computed(() => ({
    root: rootAttrs.value,
    content: { class: contentClass.value },
    transition: { onAfterEnter: settleFocus },
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
        :position="sheet ? `bottom` : position"
        :append-to="appendTo"
        :class="rootClass"
        :aria-labelledby="labelNow()"
        :aria-describedby="describedNow() ? descriptionId : undefined"
        :pt="pt"
        @show="onShow"
        @hide="onHide"
    >
        <template v-if="chrome" #header>
            <div class="ui-dialog-heading">
                <!-- A mark before the words: a confirm's tinted glyph, an extension's brand. -->
                <div v-if="$slots[`icon`]" class="ui-dialog-icon"><slot name="icon" /></div>
                <div class="ui-dialog-titles">
                    <!-- The title's own class and id, handed on so a slot's title wears the typography and still names the box. -->
                    <slot name="header" title-class="p-dialog-title" :title-id="titleId">
                        <span v-if="header !== undefined" :id="titleId" class="p-dialog-title">{{ header }}</span>
                    </slot>
                    <div v-if="describedNow()" :id="descriptionId" class="ui-dialog-description">
                        <slot name="description">{{ description }}</slot>
                    </div>
                </div>
            </div>
        </template>
        <slot />
        <template v-if="$slots[`footer`]" #footer><slot name="footer" /></template>
    </Dialog>
</template>
