import { loopDesigns, removeLoopDesign, saveLoopDesign, startLoop, stopLoop } from "./loopRuns";
import { type Doors, okAfter } from "../doors";

// Saved loops and running ones, over the loop store (daemon/loopRuns.ts).
export const loopsDoors = {
    designs: () => ({ designs: loopDesigns() }),
    saveDesign: ({ design, create }) => saveLoopDesign(design, create),
    removeDesign: ({ id }) => okAfter(() => removeLoopDesign(id)),
    start: (loop) => startLoop(loop),
    stop: ({ conversationId }) => okAfter(() => stopLoop(conversationId)),
} satisfies Doors<`loops`>;
