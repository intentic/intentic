import { sandboxRef } from "@intentic/extension-api";
import { z } from "zod";
import { type SideInput, sideTabId } from "./sideTabs";

// The core's file side view: a workspace file, in the copy the reference named. Its input is parsed where it is read
// (a stored tab is only as good as the payload it came back from), and built in one place, so the opener and the body
// cannot disagree about what a file tab holds.

export const FILE_SIDE_VIEW = `file`;

export const FileSideInputSchema = z.object({
    // Root-relative, as the Workspace names it; for a missing one, the reference as it was written.
    path: z.string().min(1),
    // The conversation whose checkout holds it; absent is the shared tree.
    agent: z.string().min(1).optional(),
    // A reference nothing in that copy matched: the tab says so and offers what it may have meant, rather than opening a
    // path that never existed and calling it deleted.
    missing: z.literal(true).optional(),
});
export type FileSideInput = z.infer<typeof FileSideInputSchema>;

// The shared tree leaves `agent` out rather than storing an empty one, so one file is one tab however it was named.
export const fileSideInput = (path: string, agent: string | undefined): SideInput => (agent === undefined ? { path } : { path, agent });

// The tab for a reference that matched nothing: a tab of its own kind, so the same words followed twice find it again.
export const missingFileSideInput = (reference: string, agent: string | undefined): SideInput => ({ ...fileSideInput(reference, agent), missing: true });

/**
 * How a file tab was reached, when that is worth saying: the reference matched several files, named one the conversation
 * has since renamed, or matched nothing. Not part of what the tab is (the same file opened another way is the same tab),
 * so it is held beside the tab rather than in its input, and like a line jump it is not stored: a reload forgets it.
 */
export interface FileArrival {
    // The reference as it was written.
    asked: string;
    // Every file it could mean, most likely first, when there was more than one; the tab shows one of them.
    matches?: readonly string[];
    // The path it named, when the conversation has since renamed that file to the one shown.
    renamedFrom?: string;
    // What it may have meant, when it matched nothing.
    nearby?: readonly string[];
}

const arrivals = sandboxRef<Readonly<Record<string, Readonly<FileArrival>>>>(() => ({}));

// Notes are few and small, but a reader following link after link would otherwise collect one per peek forever.
const KEPT_ARRIVALS = 50;

export const noteArrival = (input: SideInput, arrival: Readonly<FileArrival> | undefined): void => {
    const id = sideTabId(FILE_SIDE_VIEW, input);
    const { [id]: _replaced, ...rest } = arrivals.value;
    const kept = Object.entries(rest).slice(-(KEPT_ARRIVALS - 1));
    arrivals.value = Object.fromEntries(arrival === undefined ? kept : [...kept, [id, arrival]]);
};

export const arrivalOf = (input: SideInput): Readonly<FileArrival> | undefined => arrivals.value[sideTabId(FILE_SIDE_VIEW, input)];
