import { ElementRefs, FrameLog } from "@intentic/desktop-automation";

// What the agent has been shown of this machine's screen, for the process's life: every screenshot's frame, and the
// refs of the newest element listing. One of each, since every link drives the same one screen. The reading of them
// (pointing, regions, wording) is @intentic/desktop-automation's view.ts, shared with the sandbox's own desktop.
export const frames = new FrameLog();

export const elementRefs = new ElementRefs();
