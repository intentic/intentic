<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { pictureRect } from "../composables/browser/viewportCoords";

/* THE DROP-DOWN THE PICTURE CANNOT SHOW, drawn on this side of the wire instead.
 *
 * Chromium renders an open <select> as a native menu belonging to the browser rather than to the page, so it
 * never reaches a screencast frame: the owner clicks the control, sees nothing happen, and the click they aim
 * at the option they wanted lands on whatever the page has underneath. The daemon reads the options out of the
 * page (readSelect) and this draws them where the control is, so picking one is an ordinary click again.
 *
 * It is a REAL menu in the operator's own browser, not a picture of one — so it is sharp at any zoom, scrolls a
 * twelve-year list of birth years properly, and answers the arrow keys. Nothing is injected into the page to
 * achieve that, which matters: the agent's next snapshot must not find an overlay we left in its DOM. */

const props = defineProps<{
    menu: {
        options: readonly { label: string; disabled: boolean }[];
        selected: number;
        rect: { x: number; y: number; width: number; height: number };
    };
    // The <img> the frame paints into — the menu is placed against the picture, not against the pane.
    frame: HTMLElement | undefined;
    viewWidth: number;
    viewHeight: number;
}>();

const emit = defineEmits<{ pick: [index: number]; close: [] }>();

const listEl = ref<HTMLElement | undefined>();
// Which row the keyboard is on. Starts at the page's own current choice, so Enter alone changes nothing.
const active = ref(props.menu.selected);

const box = computed(() =>
    props.frame === undefined
        ? { left: 0, top: 0, width: 0, height: 0 }
        : pictureRect(props.frame, props.viewWidth, props.viewHeight, props.menu.rect),
);

/* Below the control, or above it when there is no room — the rule every native menu follows, and the one that
 * keeps a year list from opening off the bottom of a pane. Measured against the picture's own box. */
const placement = computed(() => {
    const paneHeight = props.frame?.getBoundingClientRect().height ?? 0;
    const below = paneHeight - (box.value.top + box.value.height);
    const wantsAbove = below < 160 && box.value.top > below;
    return {
        left: `${box.value.left}px`,
        minWidth: `${Math.max(box.value.width, 120)}px`,
        maxHeight: `${Math.max(120, (wantsAbove ? box.value.top : below) - 8)}px`,
        ...(wantsAbove ? { bottom: `${paneHeight - box.value.top}px` } : { top: `${box.value.top + box.value.height}px` }),
    };
});

const move = (delta: number): void => {
    const total = props.menu.options.length;
    for (let step = 1; step <= total; step += 1) {
        const next = (active.value + delta * step + total * total) % total;
        if (!props.menu.options[next]?.disabled) {
            active.value = next;
            return;
        }
    }
};

const onKeydown = (event: KeyboardEvent): void => {
    // Every key belongs to the menu while it is open — none of them may fall through to the page behind it.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" || event.key === "Tab") {
        emit("close");
    } else if (event.key === "ArrowDown") {
        move(1);
    } else if (event.key === "ArrowUp") {
        move(-1);
    } else if (event.key === "Home") {
        active.value = 0;
    } else if (event.key === "End") {
        active.value = props.menu.options.length - 1;
    } else if (event.key === "Enter" || event.key === " ") {
        emit("pick", active.value);
    }
};

// Open focused and scrolled to the current choice — a birth year is a long way down a list that opens at the top.
watch(
    () => props.menu,
    async () => {
        active.value = props.menu.selected;
        await nextTick();
        listEl.value?.focus();
        listEl.value?.querySelector<HTMLElement>("[data-active='true']")?.scrollIntoView({ block: "center" });
    },
    { immediate: true },
);
</script>

<template>
    <!-- Swallows the click that would otherwise reach the picture underneath and move the page's focus. -->
    <div class="absolute inset-0 z-20" @mousedown.stop.prevent="emit('close')" @wheel.stop @contextmenu.prevent></div>
    <div
        ref="listEl"
        role="listbox"
        tabindex="0"
        :style="placement"
        class="absolute z-30 overflow-y-auto rounded-md border border-line bg-card py-1 text-sm text-content shadow-lg outline-none"
        @keydown="onKeydown"
        @mousedown.stop
    >
        <button
            v-for="(option, index) in menu.options"
            :key="index"
            type="button"
            role="option"
            :aria-selected="index === menu.selected"
            :data-active="index === active"
            :disabled="option.disabled"
            class="block w-full cursor-default px-3 py-1 text-left whitespace-nowrap disabled:opacity-40"
            :class="index === active ? 'bg-primary-600 text-white' : 'hover:bg-hover'"
            @mousemove="active = index"
            @click.stop="emit('pick', index)"
        >
            {{ option.label || " " }}
        </button>
    </div>
</template>
