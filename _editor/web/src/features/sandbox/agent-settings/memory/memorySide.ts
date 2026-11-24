import { MEMORY_FILE } from "@intentic/constants";
import { z } from "zod";
import type { SideInput } from "../../../../workbench/side/sideTabs";

// The core's memory side view: one AGENTS.md, written where it is read, beside whatever section is open, so pressing a
// memory file in Settings never takes the reader away from Settings. Its input is built and parsed here, so the opener
// (AgentMemory), the body (SideMemory.vue) and the registration (coreSideViews.ts) cannot disagree about a memory tab.

export const MEMORY_SIDE_VIEW = `memory`;

export const MemorySideInputSchema = z.object({
    // Root-relative, as the daemon names it: `AGENTS.md`, or a folder's `<folder>/AGENTS.md`.
    path: z.string().min(1),
});

export const memorySideInput = (path: string): SideInput => ({ path });

// The folder whose turns read the file: empty for the workspace root's, which every turn reads.
export const memoryFolderOf = (path: string): string => (path === MEMORY_FILE ? `` : path.slice(0, -(MEMORY_FILE.length + 1)));
