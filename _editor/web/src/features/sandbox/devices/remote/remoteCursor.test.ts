// The computer's own pointer over its picture: placed by the picture's own pixels on the box the picture fills, drawn
// with the computer's cursor image where it sent one, never off the picture, and hidden while this viewer's own pointer
// moves over the stage and drives.
import { effectScope, nextTick, ref } from "vue";
import { OWN_POINTER_MS, spriteAt, useRemoteCursor } from "./remoteCursor";

// A 2x3 PNG's first bytes (signature and IHDR), base64.
const PNG_2X3 = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3));
const BOX = { left: 10, top: 20, width: 640, height: 360 };
const SIZE = { width: 1280, height: 720 };

it("places the pointer by the picture's pixels on its box, with the computer's image and hotspot", () => {
    expect(spriteAt({ x: 640, y: 360 }, SIZE, BOX, undefined)).toEqual({ left: 330, top: 200 });
    expect(spriteAt({ x: 0, y: 0 }, SIZE, BOX, { css: `text`, png: PNG_2X3, hotX: 4, hotY: 2 })).toEqual({
        left: 10,
        top: 20,
        image: { url: `data:image/png;base64,${PNG_2X3}`, width: 1, hotX: 2, hotY: 1 },
    });
    // Not an image: the arrow stands in.
    expect(spriteAt({ x: 0, y: 0 }, SIZE, BOX, { png: `not base64!` })).toEqual({ left: 10, top: 20 });
    // Off the picture (another monitor, hidden): not drawn.
    expect([spriteAt({ x: -1, y: -1 }, SIZE, BOX, undefined), spriteAt({ x: 1280, y: 5 }, SIZE, BOX, undefined)]).toEqual([undefined, undefined]);
});

it("hides it while this viewer's own pointer moves over the stage and drives, and draws it once that is still", async () => {
    const stage = document.createElement(`div`);
    const timers: { run: () => void; cancelled: boolean; ms: number }[] = [];
    const pointer = ref<{ readonly x: number; readonly y: number } | undefined>({ x: 100, y: 100 });
    const driving = ref(true);
    const scope = effectScope();
    const sprite = scope.run(() =>
        useRemoteCursor({
            pointer,
            look: ref(undefined),
            size: ref(SIZE),
            box: ref(BOX),
            driving,
            stage: ref(stage),
            later: (run, ms) => {
                const timer = { run, ms, cancelled: false };
                timers.push(timer);
                return () => (timer.cancelled = true);
            },
        }),
    )!;
    expect(sprite.value).toEqual({ left: 60, top: 70 });
    stage.dispatchEvent(new Event(`pointermove`));
    await nextTick();
    expect(sprite.value).toBeUndefined();
    // Watching, its own pointer is not the computer's.
    driving.value = false;
    expect(sprite.value).toEqual({ left: 60, top: 70 });
    driving.value = true;
    // Still for OWN_POINTER_MS: the computer's pointer, wherever it moves, is drawn again.
    const still = timers.at(-1)!;
    expect([still.ms, still.cancelled]).toEqual([OWN_POINTER_MS, false]);
    still.run();
    pointer.value = { x: 200, y: 0 };
    expect(sprite.value).toEqual({ left: 110, top: 20 });
    // Leaving the stage hands it back at once.
    stage.dispatchEvent(new Event(`pointermove`));
    stage.dispatchEvent(new Event(`pointerleave`));
    expect(sprite.value).toEqual({ left: 110, top: 20 });
    scope.stop();
});
