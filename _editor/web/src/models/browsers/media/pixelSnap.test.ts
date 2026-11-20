// The picture's canvas is nudged onto a whole device pixel of the window it is in: a popped-out pane on a screen of
// another density snaps to that screen's pixels, not the editor's.
import "@intentic/testing/dom";
import { effectScope, nextTick, ref } from "vue";
import { waitFor } from "@intentic/testing/bun";
import { usePixelSnap } from "./pixelSnap";

it("snaps to the device pixels of the element's own window", async () => {
    const element = document.createElement(`canvas`);
    element.getBoundingClientRect = () => new DOMRect(10.25, 0, 100, 100);
    const listeners = new Set<() => void>();
    // The pane's own window, at twice the editor's density.
    const popout = {
        devicePixelRatio: 2,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        matchMedia: () => ({ addEventListener: () => undefined, removeEventListener: () => undefined }),
    };
    Object.defineProperty(element, `ownerDocument`, { value: { defaultView: popout } });
    const target = ref<HTMLElement | null>(null);
    const moved = ref<object | undefined>();
    const scope = effectScope();
    const style = scope.run(() => usePixelSnap(target, moved))!;
    target.value = element;
    await nextTick();
    moved.value = {};
    // 10.25 CSS px is 20.5 device px at a ratio of 2: a quarter of a CSS px forward to the next whole one.
    await waitFor(() => expect(style.value).toEqual({ transform: `translate(0.25px, 0px)` }));
    expect(listeners.size).toBeGreaterThan(0);
    scope.stop();
    expect(listeners.size).toBe(0);
});
