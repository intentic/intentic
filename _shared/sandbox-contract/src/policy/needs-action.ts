import { z } from "zod";

// One "do this by hand" line shared by arrival, definition, runner-protocol; a leaf to avoid an import cycle.
export const NeedsActionSchema = z.object({ subject: z.string(), detail: z.string() });
export type NeedsAction = z.infer<typeof NeedsActionSchema>;
