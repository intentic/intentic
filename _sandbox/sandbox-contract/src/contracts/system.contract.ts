import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { SessionTranscriptSchema, SystemEventSchema } from "../events.js";
import {
    BrowserNameParamSchema,
    BrowsersListSchema,
    DaemonSessionSchema,
    InfoSchema,
    ManifestProblemsSchema,
    MachineFlowLineSchema,
    MachineSandboxFlowInputSchema,
    OkSchema,
    PresenceReportSchema,
    SubagentIdParamSchema,
    SubagentsListSchema,
    TerminalNameParamSchema,
    TerminalScrollbackQuerySchema,
    TerminalScrollbackSchema,
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
    // What the daemon could not read in its own `.intentic/` manifests — a file it fell back on, a key it did
    // not recognise, an entry it skipped. Its own route rather than a field on /info because it is invalidated
    // by a different thing: a manifest changing on disk, which the workspace-state table already broadcasts.
    manifestProblems: oc.route({ method: "GET", path: "/system/manifest-problems" }).output(ManifestProblemsSchema),
    // Exchange the request's verified bearer (a Google ID token — or a still-valid session, which makes this
    // route sliding renewal) for a daemon-minted session, the credential every steady-state call presents.
    session: oc.route({ method: "POST", path: "/system/session" }).output(DaemonSessionSchema),
    events: oc
        .route({ method: "GET", path: "/events" })
        .input(z.object({ clientId: z.string().optional() }))
        .output(eventIterator(SystemEventSchema)),
    // A tab's activity self-report (view/session/file/idle), fanned back out to every member on /events.
    presence: oc.route({ method: "POST", path: "/system/presence" }).input(PresenceReportSchema).output(OkSchema),
    // Per-account token/cost totals, aggregated from the activity log's turn.completed events.
    usage: oc.route({ method: "GET", path: "/system/usage" }).output(UsageSummarySchema),
    // The web-owned tmux sessions behind the terminal tabs. `terminals` enumerates them (the panel rebuilds a tab
    // per name on load/reload); `killTerminal` destroys one when its tab's close button is clicked. The live I/O
    // is the separate /system/terminal WebSocket — these are just the control plane. Bearer-authed like the rest
    // (browser fetch sends the header), unlike the header-less WS route which app.ts exempts.
    terminals: oc.route({ method: "GET", path: "/system/terminals" }).output(TerminalsListSchema),
    killTerminal: oc.route({ method: "DELETE", path: "/system/terminals/{name}" }).input(TerminalNameParamSchema).output(OkSchema),
    // One session's pane history as selectable text — the answer to "scroll back and copy that" in a surface
    // whose live view is a tmux client on the alternate screen, where the scrollback is on the far side of the
    // socket and the page has nothing to select. See TerminalScrollbackSchema.
    terminalScrollback: oc
        .route({ method: "GET", path: "/system/terminals/{name}/scrollback" })
        .input(TerminalScrollbackQuerySchema)
        .output(TerminalScrollbackSchema),
    // The agent's live Chromiums and the pages each has open — the Browsers view's roster, polled while it is on
    // screen and by the rail so its tile can appear the moment a turn starts browsing. The frames are the
    // separate /system/browser-view WebSocket; this is the control plane, exactly as `terminals` is for tmux.
    // `closeBrowser` shuts one Chromium down: the agent's next browser tool call then fails as if it had crashed,
    // which is the honest account of the owner pulling the plug.
    browsers: oc.route({ method: "GET", path: "/system/browsers" }).output(BrowsersListSchema),
    closeBrowser: oc.route({ method: "DELETE", path: "/system/browsers/{name}" }).input(BrowserNameParamSchema).output(OkSchema),
    // The agents this sandbox's agents started — SDK subagents and delegated Codex/Grok runs alike (see
    // SubagentSessionSchema). Same two-route shape as the browsers above, and same division of labour: the list
    // is polled by the Subagents area while it is on screen and loosely by the rail, so its tile can appear the
    // moment a turn delegates. There is no third WebSocket here, because a subagent has no byte stream to watch —
    // what you watch it through is its TRANSCRIPT, which `subagentTranscript` serves in the one shape every
    // other transcript route already answers in: live from the parent turn's frame log while it runs, off the
    // provider's own store once it has finished.
    subagents: oc.route({ method: "GET", path: "/system/subagents" }).output(SubagentsListSchema),
    subagentTranscript: oc
        .route({ method: "GET", path: "/system/subagents/{id}/transcript" })
        .input(SubagentIdParamSchema)
        .output(SessionTranscriptSchema),
    /* Start, stop, restart, update, rebuild, roll back or remove a sandbox on one of the user's own computers —
     * the Computers view's buttons, relayed to the machine over the socket it holds open to us.
     *
     * Streamed because the slowest of these takes minutes, and it is the same stream whatever the op: one door
     * for one decision, so the view has one shape to render rather than one per duration. The daemon adds no
     * judgement — the machine enforces its own switches and its refusal arrives as the terminal `error` line,
     * in its own words, naming the control to flip. */
    manageMachineSandbox: oc
        .route({ method: "POST", path: "/system/computers/{id}/sandboxes/{slug}" })
        .input(MachineSandboxFlowInputSchema)
        .output(eventIterator(MachineFlowLineSchema)),
};
