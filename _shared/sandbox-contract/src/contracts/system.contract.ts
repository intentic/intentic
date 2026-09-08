import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { SessionTranscriptSchema } from "../events/transcript.js";
import { SystemEventSchema } from "../events/system-events.js";
import {
    DeviceAgentFlowInputSchema,
    DeviceCommandInputSchema,
    DeviceCommandResultSchema,
    DeviceFlowLineSchema,
    DeviceSandboxFlowInputSchema,
} from "../schemas/devices.js";
import { PresenceReportSchema } from "../schemas/logs.js";
import { OkSchema } from "../schemas/shared.js";
import { DaemonSessionSchema, InfoSchema, ManifestProblemsSchema, ManifestRepairSchema } from "../schemas/system.js";
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

// Sandbox status/identity, the long-lived liveness stream, and the connect-token-relayed host tunnel. `events`
// interleaves heartbeats, workspaceChanged batches and presence snapshots until the request aborts. `clientId` is this
// tab's presence key; omitting it means never joining the roster.
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
    // Own route, not a field on /info: it goes stale on a manifest changing on disk, not on identity changing.
    manifestProblems: oc
        .route({
            method: "GET",
            path: "/system/manifest-problems",
            summary: "Settings files the sandbox could not read",
            description:
                "Anything the daemon tripped over in its own configuration on disk: a file it had to fall back from, a key it did not recognise, an entry it skipped. Separate from the identity call because it goes stale for a different reason, namely a file changing.",
        })
        .output(ManifestProblemsSchema),
    // Removes or renames only a key, never a value; writes queue through the owning store, not racing a live save.
    repairManifest: oc
        .route({
            method: "POST",
            path: "/system/manifest-problems/repair",
            summary: "Take a stray setting out of a file",
            description:
                "Removes a key the sandbox does not recognise from one of its settings files, or renames it to the one it was probably meant to be, keeping the value. Only the files a person hand-edits can be named, and only a key — never a value — so this can only ever remove something already being ignored. Renaming onto a key the file already has is refused instead of overwriting it.",
        })
        .input(ManifestRepairSchema)
        .output(OkSchema),
    // Trades a verified bearer or unexpired session for a fresh daemon session; calling it again renews it.
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
    // Control plane only; live I/O is /system/terminal WebSocket, exempt from the Bearer auth these routes take.
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
    // Scrollback as selectable text; the live view is a tmux alternate screen, with nothing in the page to select.
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
    // Control plane like `terminals`; frames stream separately. `closeBrowser` fails the next call as crashed.
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
    // SDK subagents and delegated runs alike; watched via transcript, not a socket, live then from stored history.
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
    // One stream for every op; the daemon adds no judgment, a refusal is the machine's own `error` line.
    manageDeviceSandbox: oc
        .route({
            method: "POST",
            path: "/system/devices/{id}/sandboxes/{slug}",
            summary: "Drive a sandbox on one of your own devices",
            description:
                "Start, stop, restart, update, rebuild, roll back, reshape (its memory and CPU caps, privileged, GPU) or remove a sandbox running on a machine you own, relayed over the connection that machine holds open. The answer is a stream because the slowest of these takes minutes, and it is the same stream whichever you ask for. The daemon adds no opinion: the machine enforces its own permissions and a refusal arrives as the last line, in the machine's words, naming the switch to flip.",
        })
        .input(DeviceSandboxFlowInputSchema)
        .output(eventIterator(DeviceFlowLineSchema)),
    // Closed set of actions; the daemon builds the command line, not the caller. One sentence is the whole answer.
    runDeviceCommand: oc
        .route({
            method: "POST",
            path: "/system/devices/{id}/commands/{command}",
            summary: "Run one of your device's own CLI actions",
            description:
                "Performs a named action on a machine you own by running its own intentic-machine command there — turning that device's port mirroring off, say — over the connection it holds open. The set of actions is fixed and the command line is built here from the name, never sent by the caller. The machine enforces its own permissions and a refusal comes back as its own sentence, naming the switch to flip.",
        })
        .input(DeviceCommandInputSchema)
        .output(DeviceCommandResultSchema),
    // The stream usually ends without a frame; a bare stop means success, the device's version confirms it later.
    runDeviceAgentFlow: oc
        .route({
            method: "POST",
            path: "/system/devices/{id}/agent/{op}",
            summary: "Update or restart the agent on one of your own devices",
            description:
                "Updates a machine you own to the current intentic-machine agent, or restarts the loop it is running, over the connection that machine holds open. The answer is a stream of the run's own output — and it normally stops mid-run, because the agent's loop is what carries this connection: the work is detached from it first, so it finishes regardless, and the device's reported version is what confirms it. Takes the machine's \"Run commands\" permission, the same one a command typed there would.",
        })
        .input(DeviceAgentFlowInputSchema)
        .output(eventIterator(DeviceFlowLineSchema)),
};
