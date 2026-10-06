import { z } from "zod";
import type { SideInput } from "./sideTabs";

// The core's file side view: a workspace file, in the copy the reference named. Its input is parsed where it is read
// (a stored tab is only as good as the payload it came back from), and built in one place, so the opener and the body
// cannot disagree about what a file tab holds.

export const FILE_SIDE_VIEW = `file`;

export const FileSideInputSchema = z.object({
    // Root-relative, as the Workspace names it.
    path: z.string().min(1),
    // The conversation whose checkout holds it; absent is the shared tree.
    agent: z.string().min(1).optional(),
});
export type FileSideInput = z.infer<typeof FileSideInputSchema>;

// The shared tree leaves `agent` out rather than storing an empty one, so one file is one tab however it was named.
export const fileSideInput = (path: string, agent: string | undefined): SideInput => (agent === undefined ? { path } : { path, agent });
