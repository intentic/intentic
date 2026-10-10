import type { RawRouteKey } from "@intentic/sandbox-contract";
import { serve } from "@intentic/contract-serve";
import { browserSession } from "./browser";
import { procedures } from "./daemon/procedures";
import { raw } from "./daemon/raw";
import { terminalSession } from "./terminal";
import type { DemoSession } from "./transport";
import { UNSERVED } from "./unserved";

// The daemon the demo stands in for: procedures.ts answers every oRPC procedure in its contract's types, raw.ts every
// other route the app reaches, and the two below upgrade to a WebSocket, answered by a recorded session. serve() ties
// them into one dispatcher; a shape that drifts from the wire is a build error.

// The raw routes that upgrade to a WebSocket, answered by a recorded session instead of through fetch.
export const sockets = {
    "GET /system/terminal": terminalSession,
    "GET /system/browser-view": browserSession,
} satisfies { readonly [K in RawRouteKey]?: DemoSession };

export const daemon = serve(procedures, raw, UNSERVED, { speaker: `The demo fixture`, tag: `[demo]`, log: console.info });
