import { z } from "zod";

/* One "do this by hand" line, the definition surface's honesty unit (definition.ts is the home story; this
 * lives in its own leaf module because runner-protocol.ts also speaks it, and THAT file is imported by
 * schemas.ts, which definition.ts imports — the schema living in definition.ts made a cycle that left
 * schemas half-initialized under module-eval). A subject the UI bolds, a detail written as an instruction. */
export const DefinitionActionSchema = z.object({ subject: z.string(), detail: z.string() });
export type DefinitionAction = z.infer<typeof DefinitionActionSchema>;
