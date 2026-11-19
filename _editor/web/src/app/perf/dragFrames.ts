import { layoutResizing } from "@intentic/ui";
import { watch } from "vue";
import { recordPerf } from "./perf";

// WHILE A RESIZE HANDLE IS DRAGGED, EVERY FRAME'S LENGTH IS A SPAN (`layout.drag`, budgeted in perf.ts at a dropped
// frame): a drag that stutters warns and reports the way a slow streamed frame does, and `__intenticPerf.table()` says
// how many of a drag's frames were late, which the long-frame report (only frames past 300ms) cannot. Only during a
// drag: the rest of the time no frame is asked for.
export const watchDragFrames = (): void => {
    let running = false;
    let last = 0;
    const frame = (now: number): void => {
        if (!layoutResizing.value) {
            running = false;
            return;
        }
        if (last !== 0) {
            recordPerf(`layout.drag`, now - last);
        }
        last = now;
        requestAnimationFrame(frame);
    };
    watch(layoutResizing, (on) => {
        if (on && !running) {
            running = true;
            last = 0;
            requestAnimationFrame(frame);
        }
    });
};
