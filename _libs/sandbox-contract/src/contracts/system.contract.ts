import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { SystemEventSchema } from "../events.js";
import {
    HostTunnelInputSchema,
    HostTunnelSchema,
    InfoSchema,
    OkSchema,
    PresenceReportSchema,
    TerminalNameParamSchema,
    TerminalsListSchema,
    UsageSummarySchema,
} from "../schemas.js";

// Sandbox status + identity, the long-lived liveness stream, and the connect-token-relayed host tunnel.
// `events` interleaves heartbeat frames (browser holds it open to detect the sandbox dying instantly) with
// workspaceChanged batches (live file tree/viewer refresh) and presence roster snapshots until the request
// aborts. `clientId` is the tab's per-connection presence key; absent (an older web client) means the
// connection simply never joins the roster.
export const systemContract = {
    info: oc.route({ method: "GET", path: "/info" }).output(InfoSchema),
    events: oc
        .route({ method: "GET", path: "/events" })
        .input(z.object({ clientId: z.string().optional() }))
        .output(eventIterator(SystemEventSchema)),
    // A tab's activity self-report (view/session/file/idle), fanned back out to every member on /events.
    presence: oc.route({ method: "POST", path: "/system/presence" }).input(PresenceReportSchema).output(OkSchema),
    hostTunnel: oc.route({ method: "POST", path: "/system/host-tunnel" }).input(HostTunnelInputSchema).output(HostTunnelSchema),
    // Per-account token/cost totals, aggregated from the activity log's turn.completed events.
    usage: oc.route({ method: "GET", path: "/system/usage" }).output(UsageSummarySchema),
    // The web-owned tmux sessions behind the terminal tabs. `terminals` enumerates them (the panel rebuilds a tab
    // per name on load/reload); `killTerminal` destroys one when its tab's close button is clicked. The live I/O
    // is the separate /system/terminal WebSocket — these are just the control plane. Bearer-authed like the rest
    // (browser fetch sends the header), unlike the header-less WS route which app.ts exempts.
    terminals: oc.route({ method: "GET", path: "/system/terminals" }).output(TerminalsListSchema),
    killTerminal: oc.route({ method: "DELETE", path: "/system/terminals/{name}" }).input(TerminalNameParamSchema).output(OkSchema),
};
