<!--
    The app's anchored overlay: a panel pinned to its trigger, teleported and measured against the trigger's own `ownerDocument`/`defaultView` rather
    than the module-scope window, so it works in a popped-out panel. Dismissal is a stateless outside pointerdown; Escape binds in the bubble phase
    so content can intercept it first.
-->
<script setup lang="ts">
import { computed, type CSSProperties, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { type Cross, placeAnchored, type Placement, type Side } from "../../lib/anchorPlacement.js";

const {
    anchor,
    side = `top`,
    cross = `start`,
    gap = 8,
    edge = 8,
} = defineProps<{
    // The element the panel hangs off: also the window it opens in, and the click that never dismisses it.
    anchor: HTMLElement | undefined;
    side?: Side;
    cross?: Cross;
    gap?: number;
    edge?: number;
}>();

const open = defineModel<boolean>({ required: true });

const box = ref<HTMLElement>();
// Undefined until measured; parked off-screen via one :style binding, never written to imperatively.
const placement = ref<Placement>();

const style = computed<CSSProperties>(() =>
    placement.value === undefined
        ? { transform: `translate(-200vw, -200vh)`, pointerEvents: `none` }
        : {
              left: `${Math.round(placement.value.left)}px`,
              top: `${Math.round(placement.value.top)}px`,
              maxHeight: `${Math.round(placement.value.maxHeight)}px`,
              "--ui-anchored-arrow": `${Math.round(placement.value.arrow)}px`,
          },
);

const reposition = (): void => {
    const el = box.value;
    const view = anchor?.ownerDocument.defaultView;
    if (el === undefined || anchor === undefined || view === null || view === undefined) {
        return;
    }
    const rect = anchor.getBoundingClientRect();
    // A zero-size anchor (hidden, unmounted, scrolled away) has nothing to point at; close instead of guessing.
    if (rect.width === 0 && rect.height === 0) {
        open.value = false;
        return;
    }
    placement.value = placeAnchored({
        anchor: rect,
        box: el.getBoundingClientRect(),
        view: { width: view.innerWidth, height: view.innerHeight },
        side,
        cross,
        gap,
        edge,
    });
};

// Tracks which document/window are armed, so disarming still works if the anchor later moves elsewhere.
let armed: { readonly doc: Document; readonly view: Window; readonly observer: ResizeObserver } | undefined;

const onPointerDown = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Node)) {
        return;
    }
    // Excludes the anchor so its own click still toggles, rather than dismissing right before it reopens.
    if (box.value?.contains(target) === true || anchor?.contains(target) === true) {
        return;
    }
    open.value = false;
};

const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === `Escape`) {
        open.value = false;
    }
};

// A window that loses focus closes its menus: the one dismissal a listener inside this window can't see (e.g. a
// popped-out panel).
const onBlur = (): void => {
    open.value = false;
};

const disarm = (): void => {
    if (armed === undefined) {
        return;
    }
    armed.doc.removeEventListener(`pointerdown`, onPointerDown, true);
    armed.doc.removeEventListener(`keydown`, onKeydown);
    armed.doc.removeEventListener(`scroll`, reposition, true);
    armed.view.removeEventListener(`resize`, reposition);
    armed.view.removeEventListener(`blur`, onBlur);
    armed.observer.disconnect();
    armed = undefined;
};

const arm = (): void => {
    const doc = anchor?.ownerDocument;
    const view = doc?.defaultView;
    if (doc === undefined || view === null || view === undefined || box.value === undefined) {
        return;
    }
    // Capture phase: a panel that stops its own clicks can't also block this from dismissing or repositioning.
    doc.addEventListener(`pointerdown`, onPointerDown, true);
    doc.addEventListener(`keydown`, onKeydown);
    doc.addEventListener(`scroll`, reposition, true);
    view.addEventListener(`resize`, reposition);
    view.addEventListener(`blur`, onBlur);
    // Repositions on the panel's own resize (content growing, a group expanding) to keep it off the window edge.
    // Observed via the anchor's window: this window paints nothing while behind a pop-out.
    const observer = new view.ResizeObserver(() => reposition());
    observer.observe(box.value);
    armed = { doc, view, observer };
};

watch(
    [open, () => anchor],
    async ([isOpen]) => {
        disarm();
        placement.value = undefined;
        if (!isOpen) {
            // If focus fell to <body> when the panel closed, return it to the anchor so Tab doesn't restart at the
            // document top.
            // Left alone if the user has already focused something else since.
            const doc = anchor?.ownerDocument;
            if (doc !== undefined && doc.activeElement === doc.body) {
                anchor?.focus();
            }
            return;
        }
        await nextTick(); // The box exists, and has a size, only after this render.
        reposition();
        arm();
    },
    { flush: `post` },
);

onBeforeUnmount(disarm);
</script>

<template>
    <Teleport v-if="open && anchor !== undefined" :to="anchor.ownerDocument.body">
        <div ref="box" class="ui-anchored" :class="`ui-anchored-${placement?.side ?? side}`" :style="style" role="dialog" aria-modal="false">
            <!--
                This div is the surface that paints and clips; the frame around it must not, or it would cut off its
                own arrow.
            -->
            <div class="ui-anchored-surface">
                <slot />
            </div>
        </div>
    </Teleport>
</template>
