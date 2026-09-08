<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { pictureRect } from "../../browsers/viewportCoords";

// An open <select>'s native menu never reaches the screencast, so the daemon reads its options (readSelect) and
// this draws a real menu on this side of the wire: sharp at any zoom, scrollable, keyboard-driven, with nothing
// injected into the page's DOM.

const props = defineProps<{
    menu: {
        options: readonly { label: string; disabled: boolean }[];
        selected: number;
        rect: { x: number; y: number; width: number; height: number };
    };
    // The <img> the frame paints into; the menu is placed against the picture, not the pane.
    frame: HTMLElement | undefined;
    viewWidth: number;
    viewHeight: number;
}>();

const emit = defineEmits<{ pick: [index: number]; close: [] }>();

const listEl = ref<HTMLElement | undefined>();
// Which row the keyboard is on; starts at the page's current choice so Enter alone changes nothing.
const active = ref(props.menu.selected);

const box = computed(() =>
    props.frame === undefined
        ? { left: 0, top: 0, width: 0, height: 0 }
        : pictureRect(props.frame, props.viewWidth, props.viewHeight, props.menu.rect),
);

// Below the control, or above when there's no room, measured against the picture's own box, so a long list doesn't
// open off the pane.
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
    // Every key belongs to the open menu; none fall through to the page behind it.
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

// Opens focused and scrolled to the current choice, since a birth-year list opens far from the top.
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
    <!-- Swallows the click that would otherwise reach the picture underneath and move its focus. -->
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
            class="ui-row-select ui-off block w-full cursor-default px-3 py-1 text-left whitespace-nowrap"
            :class="index === active ? `ui-row-select-on` : ``"
            @mousemove="active = index"
            @click.stop="emit('pick', index)"
        >
            {{ option.label || " " }}
        </button>
    </div>
</template>
