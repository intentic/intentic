import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { SessionTranscriptSchema, SystemEventSchema } from "../events.js";
import {
    MachineCommandInputSchema,
    MachineCommandResultSchema,
    MachineFlowLineSchema,
    MachineSandboxFlowInputSchema,
} from "../schemas/computers.js";
import { PresenceReportSchema } from "../schemas/logs.js";
import { OkSchema } from "../schemas/shared.js";
import { DaemonSessionSchema, InfoSchema, ManifestProblemsSchema } from "../schemas/system.js";
import {
    BrowserNameParamSchema,
    BrowsersListSchema,
    SubagentIdParamSchema,
    SubagentsListSchema,
    TerminalNameParamSchema,
    TerminalScrollbackQuerySchema,
    TerminalScrollbackSchema,
    TerminalsListSchema,
} from "../schemas/terminal.js";
import { UsageSummarySchema } from "../schemas/usage.js";

// Sandbox status + identity, the long-lived liveness stream, and the connect-token-relayed host tunnel.
// `events` interleaves heartbeat frames (browser holds it open to detect the sandbox dying instantly) with
// workspaceChanged batches (live file tree/viewer refresh) and presence roster snapshots until the request
// aborts. `clientId` is the tab's per-connection presence key; absent (an older web client) means the
// connection simply never joins the roster.
export const systemContract = {
    info: oc
        .route({
            method: "GET",
            path: "/info",
            summary: "What this sandbox is",
            description:
                "The sandbox's own identity and state: which workspace it holds, which image it runs, what it is called, and the list of calls it actually implements. Start here, because a browser is routinely newer than the sandbox it is talking to and this is how it finds out what is there.",
        })
        .output(InfoSchema),
    // What the daemon could not read in its own `.intentic/` manifests, a file it fell back on, a key it did
    // not recognise, an entry it skipped. Its own route rather than a field on /info because it is invalidated
    // by a different thing: a manifest changing on disk, which the workspace-state table already broadcasts.
    manifestProblems: oc
        .route({
            method: "GET",
            path: "/system/manifest-problems",
            summary: "Settings files the sandbox could not read",
            description:
                "Anything the daemon tripped over in its own configuration on disk: a file it had to fall back from, a key it did not recognise, an entry it skipped. Separate from the identity call because it goes stale for a different reason, namely a file changing.",
        })
        .output(ManifestProblemsSchema),
    // Exchange the request's verified bearer (a Google ID token, or a still-valid session, which makes this
    // route sliding renewal) for a daemon-minted session, the credential every steady-state call presents.
    session: oc
        .route({
            method: "POST",
            path: "/system/session",
            summary: "Trade a sign-in for a session",
            description:
                "Exchanges a verified sign-in, or a session that has not expired yet, for a fresh session the daemon minted. That session is the credential every other call carries, and calling this again with a live one renews it.",
        })
        .output(DaemonSessionSchema),
    events: oc
        .route({
            method: "GET",
            path: "/events",
            summary: "The live event stream",
            description:
                "A stream held open for as long as you want it, carrying heartbeats so a caller notices the sandbox dying at once, batches of file changes so a tree or an editor can refresh itself, and the roster of who else is looking. Give it an id for this connection to appear in that roster; leave it out and you watch without being seen.",
        })
        .input(z.object({ clientId: z.string().optional() }))
        .output(eventIterator(SystemEventSchema)),
    // A tab's activity self-report (view/session/file/idle), fanned back out to every member on /events.
    presence: oc
        .route({
            method: "POST",
            path: "/system/presence",
            summary: "Say what you are looking at",
            description:
                "Reports which view, conversation or file this connection is on, or that it has gone idle. The daemon fans it back out on the event stream so everyone else's roster updates.",
        })
        .input(PresenceReportSchema)
        .output(OkSchema),
    // Per-account token/cost totals, aggregated from the activity log's turn.completed events.
    usage: oc
        .route({
            method: "GET",
            path: "/system/usage",
            summary: "What has been spent",
            description: "Token and cost totals per account, added up from the record of every finished turn.",
        })
        .output(UsageSummarySchema),
    // The web-owned tmux sessions behind the terminal tabs. `terminals` enumerates them (the panel rebuilds a tab
    // per name on load/reload); `killTerminal` destroys one when its tab's close button is clicked. The live I/O
    // is the separate /system/terminal WebSocket, these are just the control plane. Bearer-authed like the rest
    // (browser fetch sends the header), unlike the header-less WS route which app.ts exempts.
    terminals: oc
        .route({
            method: "GET",
            path: "/system/terminals",
            summary: "Open terminals",
            description:
                "The terminal sessions this sandbox is holding, which is what a terminal panel rebuilds its tabs from after a reload. The live typing and output run over a separate socket; this is the list.",
        })
        .output(TerminalsListSchema),
    killTerminal: oc
        .route({
            method: "DELETE",
            path: "/system/terminals/{name}",
            summary: "Close a terminal",
            description: "Destroys one terminal session and whatever was running inside it.",
        })
        .input(TerminalNameParamSchema)
        .output(OkSchema),
    // One session's pane history as selectable text, the answer to "scroll back and copy that" in a surface
    // whose live view is a tmux client on the alternate screen, where the scrollback is on the far side of the
    // socket and the page has nothing to select. See TerminalScrollbackSchema.
    terminalScrollback: oc
        .route({
            method: "GET",
            path: "/system/terminals/{name}/scrollback",
            summary: "A terminal's history as plain text",
            description:
                "What has scrolled past in one terminal, as text you can select and copy. The live view is a picture of a screen on the far side of a socket, with nothing in the page to select, so scrolling back and copying is this call rather than a gesture.",
        })
        .input(TerminalScrollbackQuerySchema)
        .output(TerminalScrollbackSchema),
    // The agent's live Chromiums and the pages each has open, the Browsers view's roster, polled while it is on
    // screen and by the rail so its tile can appear the moment a turn starts browsing. The frames are the
    // separate /system/browser-view WebSocket; this is the control plane, exactly as `terminals` is for tmux.
    // `closeBrowser` shuts one Chromium down: the agent's next browser tool call then fails as if it had crashed,
    // which is the honest account of the owner pulling the plug.
    browsers: oc
        .route({
            method: "GET",
            path: "/system/browsers",
            summary: "Browsers the agent has open",
            description:
                "Every browser a conversation currently has running and the pages inside each one. The picture of what they are showing comes over a separate socket; this is the roster.",
        })
        .output(BrowsersListSchema),
    closeBrowser: oc
        .route({
            method: "DELETE",
            path: "/system/browsers/{name}",
            summary: "Shut a browser down",
            description:
                "Closes one of the agent's browsers. Its next attempt to use that browser then fails as though it had crashed, which is the honest account of somebody pulling the plug.",
        })
        .input(BrowserNameParamSchema)
        .output(OkSchema),
    // The agents this sandbox's agents started. SDK subagents and delegated Codex/Grok runs alike (see
    // SubagentSessionSchema). Same two-route shape as the browsers above, and same division of labour: the list
    // is polled by the Subagents area while it is on screen and loosely by the rail, so its tile can appear the
    // moment a turn delegates. There is no third WebSocket here, because a subagent has no byte stream to watch,
    // what you watch it through is its TRANSCRIPT, which `subagentTranscript` serves in the one shape every
    // other transcript route already answers in: live from the parent turn's frame log while it runs, off the
    // provider's own store once it has finished.
    subagents: oc
        .route({
            method: "GET",
            path: "/system/subagents",
            summary: "Subagents the agents have started",
            description:
                "Every subagent and child agent this sandbox's conversations have delegated work to, whichever tool started it, with what each one is doing.",
        })
        .output(SubagentsListSchema),
    subagentTranscript: oc
        .route({
            method: "GET",
            path: "/system/subagents/{id}/transcript",
            summary: "A subagent's record",
            description:
                "The full record of one delegated subagent, in the same shape as any other conversation. It comes live from the parent turn while it works, and from stored history once it has finished.",
        })
        .input(SubagentIdParamSchema)
        .output(SessionTranscriptSchema),
    /* Start, stop, restart, update, rebuild, roll back or remove a sandbox on one of the user's own computers,
     * the Computers view's buttons, relayed to the machine over the socket it holds open to us.
     *
     * Streamed because the slowest of these takes minutes, and it is the same stream whatever the op: one door
     * for one decision, so the view has one shape to render rather than one per duration. The daemon adds no
     * judgement, the machine enforces its own switches and its refusal arrives as the terminal `error` line,
     * in its own words, naming the control to flip. */
    manageMachineSandbox: oc
        .route({
            method: "POST",
            path: "/system/computers/{id}/sandboxes/{slug}",
            summary: "Drive a sandbox on one of your own computers",
            description:
                "Start, stop, restart, update, rebuild, roll back or remove a sandbox running on a machine you own, relayed over the connection that machine holds open. The answer is a stream because the slowest of these takes minutes, and it is the same stream whichever you ask for. The daemon adds no opinion: the machine enforces its own permissions and a refusal arrives as the last line, in the machine's words, naming the switch to flip.",
        })
        .input(MachineSandboxFlowInputSchema)
        .output(eventIterator(MachineFlowLineSchema)),
    /* Run one of this product's own CLI actions on a connected computer, from a button rather than through an
     * agent. A closed set of names, and the daemon builds the command line from the name (see the schema): the
     * browser never sends one, because the socket underneath also carries `run_command`.
     *
     * Not a stream, unlike the sandbox ops beside it: these are seconds-long CLI calls whose whole answer is the
     * sentence they print at the end, and a stream for that is a shape with nothing to put in it. */
    runMachineCommand: oc
        .route({
            method: "POST",
            path: "/system/computers/{id}/commands/{command}",
            summary: "Run one of your computer's own CLI actions",
            description:
                "Performs a named action on a machine you own by running its own intentic-machine command there — turning that computer's port mirroring off, say — over the connection it holds open. The set of actions is fixed and the command line is built here from the name, never sent by the caller. The machine enforces its own permissions and a refusal comes back as its own sentence, naming the switch to flip.",
        })
        .input(MachineCommandInputSchema)
        .output(MachineCommandResultSchema),
};
