import type { RawRouteKey } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { serve } from "@intentic/contract-serve";
import { browserSession } from "./browser";
import { procedures } from "./daemon/procedures";
import { raw } from "./daemon/raw";
// After the procedures: those load the platform before the roster, the order the roster's own imports need.
import { desktopSession } from "./desktop";
import { profileSession } from "./profileView";
import { speechStreamSession } from "./daemon/machine/speech";
import { speechSaySession } from "./daemon/machine/voiceSay";
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
    // The sandbox's own desktop and one account's own browser, drawn and encoded in the page (desktop.ts, profileView.ts).
    "GET /system/desktop-view": desktopSession,
    "GET /system/browser-profile": profileSession,
    // Dictation's live phrase stream and the voice that speaks replies (daemon/speech.ts, daemon/voiceSay.ts).
    "GET /speech/stream": speechStreamSession,
    "GET /speech/say": speechSaySession,
} satisfies { readonly [K in RawRouteKey]?: DemoSession };

export const daemon = serve(procedures, raw, UNSERVED, { speaker: `The demo fixture`, tag: `[demo]`, log: console.info });
