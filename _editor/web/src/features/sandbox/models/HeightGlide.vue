<script setup lang="ts">
import { canAnimate, FOLD_EASE, FOLD_MS, lessMotion } from "@intentic/ui/motion";
import { onBeforeUnmount, onMounted, useTemplateRef } from "vue";

// A BOX THAT EASES TO ITS CONTENT'S HEIGHT instead of snapping: a sign-in's steps differ in height (a code, a field, a
// line of waiting), and the panel jumping between them in one frame read as something broken rather than something
// moving on. The content lays out at once; only this box's height is played from the old figure to the new one, on the
// fold's duration and curve, clipped while it plays and never at rest (a focus ring at the edge stays whole). A content
// that changes mid-glide starts the next one from where the box is drawn, so two quick steps never jump back. Under the
// reduced-motion choice, or without the Web Animations API (a test DOM), the box simply takes the new height.

const outer = useTemplateRef<HTMLElement>(`outer`);
const inner = useTemplateRef<HTMLElement>(`inner`);

let last = 0;
let glide: Animation | undefined;
let observer: ResizeObserver | undefined;

const follow = (): void => {
    const box = outer.value;
    const content = inner.value;
    if (box == null || content == null) {
        return;
    }
    const next = content.offsetHeight;
    // Read before the running glide is dropped: mid-glide, where the box is drawn is where the next one starts.
    const from = glide === undefined ? last : box.getBoundingClientRect().height;
    last = next;
    glide?.cancel();
    glide = undefined;
    if (!canAnimate(box) || lessMotion() || Math.abs(next - from) < 2) {
        return;
    }
    box.style.overflow = `clip`;
    const run = box.animate([{ height: `${from}px` }, { height: `${next}px` }], { duration: FOLD_MS, easing: FOLD_EASE });
    glide = run;
    run.onfinish = (): void => {
        if (glide === run) {
            glide = undefined;
            box.style.overflow = ``;
        }
    };
};

onMounted(() => {
    last = inner.value?.offsetHeight ?? 0;
    if (inner.value != null && `ResizeObserver` in globalThis) {
        observer = new ResizeObserver(follow);
        observer.observe(inner.value);
    }
});
onBeforeUnmount(() => {
    observer?.disconnect();
    glide?.cancel();
});
</script>

<template>
    <div ref="outer">
        <!-- `flow-root`: a child's margin stays inside the measured box rather than collapsing through it. -->
        <div ref="inner" class="flow-root">
            <slot />
        </div>
    </div>
</template>
