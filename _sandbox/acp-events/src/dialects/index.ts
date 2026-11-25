import type { AcpDialect } from "./dialect.js";
import { GROK_DIALECT } from "./grok.js";
import { KIMI_DIALECT } from "./kimi.js";

export * from "./dialect.js";
export { GROK_DIALECT } from "./grok.js";
export { KIMI_DIALECT } from "./kimi.js";

// The agents whose traffic needs a dialect, by the name a launch gives (the daemon's AcpLaunch.dialect, a computer's
// harness id). OpenCode and Droid have none here: OpenCode runs over its own server, not ACP (runtimes/opencode), and
// Droid is not a runtime Intentic ships.
const DIALECTS: ReadonlyMap<string, AcpDialect> = new Map([
    [GROK_DIALECT.id, GROK_DIALECT],
    [KIMI_DIALECT.id, KIMI_DIALECT],
]);

export type DialectId = "grok" | "kimi";

// The dialect a name stands for; undefined is plain ACP.
export const dialectOf = (id: string | undefined): AcpDialect | undefined => (id === undefined ? undefined : DIALECTS.get(id));
