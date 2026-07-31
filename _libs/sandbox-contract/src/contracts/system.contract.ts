import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { SystemEventSchema } from "../events.js";
import {
    BrowserNameParamSchema,
    BrowsersListSchema,
    DaemonSessionSchema,
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
    // Exchange the request's verified bearer (a Google ID token — or a still-valid session, which makes this
    // route sliding renewal) for a daemon-minted session, the credential every steady-state call presents.
    session: oc.route({ method: "POST", path: "/system/session" }).output(DaemonSessionSchema),
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
    // The agent's live Chromiums and the pages each has open — the Browsers view's roster, polled while it is on
    // screen and by the rail so its tile can appear the moment a turn starts browsing. The frames are the
    // separate /system/browser-view WebSocket; this is the control plane, exactly as `terminals` is for tmux.
    // `closeBrowser` shuts one Chromium down: the agent's next browser tool call then fails as if it had crashed,
    // which is the honest account of the owner pulling the plug.
    browsers: oc.route({ method: "GET", path: "/system/browsers" }).output(BrowsersListSchema),
    closeBrowser: oc.route({ method: "DELETE", path: "/system/browsers/{name}" }).input(BrowserNameParamSchema).output(OkSchema),
};
