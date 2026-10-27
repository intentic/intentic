import type { GroupSamples } from "./context.ts";

export const diffSamples: GroupSamples<`diff`> = () => ({
    derived: { source: `working`, repo: `web`, side: `unstaged`, path: `drop/handover.docx` },
});
