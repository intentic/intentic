<!-- THE APP'S OWN ANCHORED OVERLAY — a panel pinned to a trigger, in the WINDOW THAT TRIGGER IS IN.

     It is ours for the same reason the tooltip directive is (composables/tooltip.ts): PrimeVue's Popover works
     against the module-scope `document` and `window`. It appends to a target you have to remember to pass, it
     measures the room around the trigger with the OPENER's viewport, it arms its dismiss listener on the
     OPENER's document, and it re-aligns on the OPENER's resize. A popped-out chat panel (usePopout) renders in
     another window with its JS left in this realm, so every one of those was the wrong window at once, and the
     failure they add up to is the one that kept coming back: the picker opened off the pop-out's bottom edge
     with its top over the pill that owns it, and an overlay covering its own trigger cannot be closed by
     clicking that trigger — the click lands INSIDE the overlay, which is the click PrimeVue's dismiss logic
     ignores by design.

     Everything here derives from the anchor element instead: `anchor.ownerDocument` is where the box is
     teleported and where dismissal listens, `ownerDocument.defaultView` is what its room is measured against.
     No `append-to` to thread through, nothing to remember at the call site, and correct in either window by
     construction rather than by a listener-mirroring trick that only covers what happens to bind to
     `document`.

     DISMISSAL IS STATELESS: a `pointerdown` outside the box and outside the anchor closes it. PrimeVue instead
     kept a `selfClick` flag set by its content's mousedown and cleared by the document's click — a two-event
     handshake that leaves the flag stuck true whenever the pair doesn't complete (a drag out of the panel, a
     click whose target Vue removed mid-press, a click that landed in the other window), and a stuck flag
     swallows the next dismissal. Pointerdown also fires before focus moves, so the picker never fights the
     panel it opened over. Escape is bound in the BUBBLE phase on purpose: content that wants Escape first
     (the model picker clears its search query with it) can still stopPropagation. -->
<script setup lang="ts">
import { computed, type CSSProperties, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { type Cross, placeAnchored, type Placement, type Side } from "../composables/anchorPlacement.js";

const {
    anchor,
    side = `top`,
    cross = `start`,
    gap = 8,
    edge = 8,
} = defineProps<{
    // The element the panel hangs off — also the window it opens in, and the one click that never dismisses it.
    anchor: HTMLElement | undefined;
    side?: Side;
    cross?: Cross;
    gap?: number;
    edge?: number;
}>();

const open = defineModel<boolean>({ required: true });

const box = ref<HTMLElement>();
/* WHERE THE BOX IS — undefined until it has been measured, and PARKED off-screen for as long as it is. The box
 * is rendered in order to be measured, so it exists before it has coordinates; painted then, it flashes in the
 * corner of the window on every open. Parked rather than hidden, because the two obvious ways to hide it both
 * break something here: `visibility: hidden` cannot take focus, and the panel inside is expected to claim it
 * (the model picker focuses its search box as it mounts, in that very frame), while `opacity: 0` loses to the
 * fade-in animation, which is a higher cascade origin than an inline style. A translate is neither, and it
 * leaves the box's measured SIZE untouched.
 *
 * AND PLACING IT IS A BINDING, NEVER A WRITE ON TOP OF ONE. Both states are the one `:style` below, because an
 * element Vue binds a style on cannot also be positioned through `el.style`: the moment that binding goes from
 * the parked object to nothing, Vue patches it as `removeAttribute("style")` and takes the left, top,
 * max-height and arrow written imperatively a microtask earlier with it. The box then sat unstyled in the
 * window's top-left corner — the very flash the parking exists to prevent, dressed as the fix for it. It was
 * the ResizeObserver's first delivery that recovered it, which is why a POP-OUT showed it worst: an observer
 * watching an element in another window rides the OPENER's rendering loop, so the correction lands frames late
 * out there, and not at all while the opener is a background tab. One value, applied one way, cannot be
 * half-applied. */
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
    // An anchor with no box (display:none, unmounted mid-open) or one scrolled clean out of its window has
    // nothing left to point at — the panel would sit somewhere arbitrary claiming to belong to it.
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

// What is armed while the panel is up, and on WHICH document/window — remembered so the same pair is disarmed
// even after the anchor has moved to another window (a panel docking mid-open) or gone away entirely.
let armed: { readonly doc: Document; readonly view: Window; readonly observer: ResizeObserver } | undefined;

const onPointerDown = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Node)) {
        return;
    }
    // The anchor is excluded so its own click still TOGGLES: dismissing here would close the panel a beat
    // before the trigger's click handler reopened it.
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

// A window the user has switched away from closes its menus — the same thing the OS does with a native one,
// and the one dismissal a listener inside this window cannot see: with the chat popped out, clicking in the
// main app window is "outside" in every sense the user means.
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
    // Pointerdown in CAPTURE, so a panel that stops its own clicks from bubbling cannot also stop the overlay
    // over it from closing. Scroll likewise: it is the scrolling ANCESTOR that fires, whichever it is.
    doc.addEventListener(`pointerdown`, onPointerDown, true);
    doc.addEventListener(`keydown`, onKeydown);
    doc.addEventListener(`scroll`, reposition, true);
    view.addEventListener(`resize`, reposition);
    view.addEventListener(`blur`, onBlur);
    // The panel's own size is live — filtering the model list, expanding a provider group, an account row
    // growing a second line. Re-placing on its resize is what keeps a growing panel off the window's edge.
    // The ANCHOR's window builds it, like every listener above: an observer delivers on the rendering steps of
    // the realm that made it, and this realm's window paints nothing while it sits behind the pop-out.
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
            /* THE KEYBOARD'S PLACE, HANDED BACK. A panel that closes while focus lived inside it (Escape, or a
             * row that picked something) leaves the document focusing <body> — from there Tab restarts at the
             * top of the window and the keyboard user has lost the composer entirely. Anything else the user
             * has since focused is left alone, because then they have already said where they want to be:
             * clicking a different control, or the pointer dismissal that closed this. Deciding it here, once
             * the DOM has settled, rather than inside each dismissal path, is what makes it hold no matter WHO
             * closed the panel — the content's own emit gets it as much as Escape does. */
            const doc = anchor?.ownerDocument;
            if (doc !== undefined && doc.activeElement === doc.body) {
                anchor?.focus();
            }
            return;
        }
        await nextTick(); // the box exists (and has a size) only after this render
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
            <!-- The surface is what paints and CLIPS; the frame above it cannot, or it would cut off its own
                 arrow. See anchored-overlay.css. -->
            <div class="ui-anchored-surface">
                <slot />
            </div>
        </div>
    </Teleport>
</template>
