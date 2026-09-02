import { z } from "zod";

/* ONE "DO THIS BY HAND" LINE, the honesty unit three surfaces share: what an arrival could not do for the
 * owner (arrival.ts), what a derived definition could not express (definition.ts), and where a runner has
 * drifted from its parent (runner-protocol.ts). A subject the UI bolds, a detail written as an instruction.
 *
 * It lives in its own leaf module because runner-protocol.ts speaks it, and THAT file is imported by
 * schemas/agent.ts, which definition.ts imports — the schema living in definition.ts made a cycle that left
 * schemas half-initialized under module-eval.
 *
 * The name says the FIELD it fills (`needsAction`) rather than any one surface, because naming it for the
 * definition is what let the arrival surfaces drift apart in the first place. */
export const NeedsActionSchema = z.object({ subject: z.string(), detail: z.string() });
export type NeedsAction = z.infer<typeof NeedsActionSchema>;
