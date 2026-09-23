import { procedure } from "../protocol/route-meta.js";
import { streamOf } from "../protocol/routes.js";
import { z } from "zod";
import { SessionTranscriptSchema } from "../events/transcript.js";
import { SystemEventSchema } from "../events/system-events.js";
import {
    DeviceAgentFlowInputSchema,
    DeviceCommandInputSchema,
    DeviceCommandResultSchema,
    DeviceFlowLineSchema,
    DeviceSandboxFlowInputSchema,
    DevicesListSchema,
} from "../schemas/devices.js";
import { PresenceReportSchema } from "../schemas/logs.js";
import { SandboxMetricsSchema, StorageCleanInputSchema, StorageCleanResultSchema, StorageReportSchema } from "../schemas/metrics.js";
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
import { UsageSummarySchema } from "../schemas/providers/usage.js";

// The box itself (terminals, devices, sessions, spend), which no control token reaches whatever the floor.
const systemRoute = procedure.meta({ control: "never" });

// Sandbox status/identity, the long-lived liveness stream, and the connect-token-relayed host tunnel. `events`
// interleaves heartbeats, workspaceChanged batches and presence snapshots until the request aborts. `clientId` is this
// tab's presence key; omitting it means never joining the roster.
export const systemContract = {
    info: procedure
        .route({
            method: "GET",
            path: "/info",
            summary: "What this sandbox is",
            description:
                "The sandbox's own identity and state: which workspace it holds, which image it runs, what it is called, and the list of calls it actually implements. Start here, because a browser is routinely newer than the sandbox it is talking to and this is how it finds out what is there.",
        })
        .meta({ guest: true })
        .output(InfoSchema),
    // Own route, not a field on /info: it goes stale on a manifest changing on disk, not on identity changing.
    manifestProblems: systemRoute
        .route({
            method: "GET",
            path: "/system/manifest-problems",
            summary: "Settings files the sandbox could not read",
            description:
                "Anything the daemon tripped over in its own configuration on disk: a file it had to fall back from, a key it did not recognise, an entry it skipped. Separate from the identity call because it goes stale for a different reason, namely a file changing.",
        })
        .output(ManifestProblemsSchema),
    // Removes or renames only a key, never a value; writes queue through the owning store, not racing a live save.
    repairManifest: systemRoute
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
    session: systemRoute
        .route({
            method: "POST",
            path: "/system/session",
            summary: "Trade a sign-in for a session",
            description:
                "Exchanges a verified sign-in, or a session that has not expired yet, for a fresh session the daemon minted. That session is the credential every other call carries, and calling this again with a live one renews it.",
        })
        // Staying signed in and on the roster is identity, not power, and needs nothing the boot chain builds.
        .meta({ beforeBoot: true, floor: "viewer", guest: true })
        .output(DaemonSessionSchema),
    events: procedure
        .route({
            method: "GET",
            path: "/events",
            summary: "The live event stream",
            description:
                "A stream held open for as long as you want it, carrying heartbeats so a caller notices the sandbox dying at once, batches of file changes so a tree or an editor can refresh itself, and the roster of who else is looking. Give it an id for this connection to appear in that roster; leave it out and you watch without being seen.",
        })
        .meta({ beforeBoot: true, stream: true, guest: true })
        .input(z.object({ clientId: z.string().optional() }))
        .output(streamOf(SystemEventSchema)),
    // A tab's activity self-report (view/session/file/idle), fanned back out to every member on /events.
    presence: systemRoute
        .route({
            method: "POST",
            path: "/system/presence",
            summary: "Say what you are looking at",
            description:
                "Reports which view, conversation or file this connection is on, or that it has gone idle. The daemon fans it back out on the event stream so everyone else's roster updates.",
        })
        .meta({ beforeBoot: true, floor: "viewer", guest: true })
        .input(PresenceReportSchema)
        .output(OkSchema),
    // Per-account token/cost totals, aggregated from the activity log's turn.completed events.
    usage: systemRoute
        .route({
            method: "GET",
            path: "/system/usage",
            summary: "What has been spent",
            description: "Token and cost totals per account, added up from the record of every finished turn.",
        })
        // Spend is the operator's reading, not the audience's.
        .meta({ floor: "maintainer" })
        .output(UsageSummarySchema),
    // Measured per request and never in the background: a sandbox nobody is asking pays nothing for this route.
    metrics: systemRoute
        .route({
            method: "GET",
            path: "/system/metrics",
            summary: "What the sandbox is using right now",
            description:
                "CPU and memory for the sandbox as a whole, for the daemon that runs it, for each kind of process, and for each conversation's own processes. Measured when you ask and never in between, so CPU is the use since the previous reading: the first reading after a quiet spell has memory and no CPU, and the next one a few seconds later has both.",
        })
        .output(SandboxMetricsSchema),
    // Answered from memory, never by walking the disk; a daemon restart forgets the last scan.
    storage: systemRoute
        .route({
            method: "GET",
            path: "/system/storage",
            summary: "What is filling the disk",
            description:
                "The last measurement of the sandbox's disk, by what the space is for: conversations, checkouts, restore points, caches, logs, the trash and the rest, each with its biggest parts and whether it can be cleaned from here. Reading it measures nothing; ask for a scan to measure again.",
        })
        // Names every conversation's checkout and every repository on the box: the operator's reading.
        .meta({ floor: "maintainer" })
        .output(StorageReportSchema),
    // Joins a scan already running instead of starting a second one; a time limit bounds it, so it always answers.
    scanStorage: systemRoute
        .route({
            method: "POST",
            path: "/system/storage/scan",
            summary: "Measure what is filling the disk",
            description:
                "Walks the sandbox's volumes and answers with the new measurement once it is done. A scan already running is joined rather than doubled. It stops at a time limit and says so, since a size it could not finish is still worth reading. A cancelled scan answers with the previous measurement.",
        })
        .output(StorageReportSchema),
    cancelStorageScan: systemRoute
        .route({
            method: "DELETE",
            path: "/system/storage/scan",
            summary: "Stop measuring the disk",
            description: "Stops a running scan. Whoever was waiting on it gets the previous measurement back; nothing is lost but the time.",
        })
        .output(OkSchema),
    // Re-classifies every path right before removing it; one clean at a time, and it cancels a running scan first.
    cleanStorage: systemRoute
        .route({
            method: "POST",
            path: "/system/storage/clean",
            summary: "Free the space one category holds",
            description:
                "Removes what one cleanable category holds, and says how much space that gave back. Only what is old enough and not in use goes: today's logs, a browser that is open, the weights a running model reads and a pack still being written all stay. Nothing outside the sandbox's own volumes, and nothing a category may not hold, is ever removed. Categories that cannot be cleaned are refused.",
        })
        .input(StorageCleanInputSchema)
        .output(StorageCleanResultSchema),
    // Control plane only; live I/O is /system/terminal WebSocket, exempt from the Bearer auth these routes take.
    terminals: systemRoute
        .route({
            method: "GET",
            path: "/system/terminals",
            summary: "Open terminals",
            description:
                "The terminal sessions this sandbox is holding, which is what a terminal panel rebuilds its tabs from after a reload. The live typing and output run over a separate socket; this is the list.",
        })
        // Lists tmux and the supervisor, neither built by the boot chain, for a surface on screen meanwhile.
        .meta({ beforeBoot: true })
        .output(TerminalsListSchema),
    killTerminal: systemRoute
        .route({
            method: "DELETE",
            path: "/system/terminals/{name}",
            summary: "Close a terminal",
            description: "Destroys one terminal session and whatever was running inside it.",
        })
        .input(TerminalNameParamSchema)
        .output(OkSchema),
    // Scrollback as selectable text; the live view is a tmux alternate screen, with nothing in the page to select.
    terminalScrollback: systemRoute
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
    browsers: systemRoute
        .route({
            method: "GET",
            path: "/system/browsers",
            summary: "Browsers the agent has open",
            description:
                "Every browser a conversation currently has running and the pages inside each one. The picture of what they are showing comes over a separate socket; this is the roster.",
        })
        .output(BrowsersListSchema),
    closeBrowser: systemRoute
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
    subagents: systemRoute
        .route({
            method: "GET",
            path: "/system/subagents",
            summary: "Subagents the agents have started",
            description:
                "Every subagent and child agent this sandbox's conversations have delegated work to, whichever tool started it, with what each one is doing.",
        })
        .output(SubagentsListSchema),
    subagentTranscript: systemRoute
        .route({
            method: "GET",
            path: "/system/subagents/{id}/transcript",
            summary: "A subagent's record",
            description:
                "The full record of one delegated subagent, in the same shape as any other conversation. It comes live from the parent turn while it works, and from stored history once it has finished.",
        })
        .input(SubagentIdParamSchema)
        .output(SessionTranscriptSchema),
    // On the contract, not a hand-written route beside it: this payload is what every "do it out there" button is
    // gated on, so its shape has to be fingerprinted like any other, or a daemon older than the app disagrees about
    // it silently and the buttons just stop being drawn.
    devices: systemRoute
        .route({
            method: "GET",
            path: "/system/devices",
            summary: "The machines you have connected",
            description:
                "Every computer this sandbox can see, whether it reached it through desktop sync or through a connected device, in one row per machine: what it says about itself, which sandboxes it holds, and what stopped it answering when nothing came back.",
        })
        .output(DevicesListSchema),
    // One stream for every op; the daemon adds no judgment, a refusal is the machine's own `error` line.
    manageDeviceSandbox: systemRoute
        .route({
            method: "POST",
            path: "/system/devices/{id}/sandboxes/{slug}",
            summary: "Drive a sandbox on one of your own devices",
            description:
                "Start, stop, restart, update, rebuild, roll back, reshape (its memory and CPU caps, privileged, GPU) or remove a sandbox running on a machine you own, relayed over the connection that machine holds open. The answer is a stream because the slowest of these takes minutes, and it is the same stream whichever you ask for. The daemon adds no opinion: the machine enforces its own permissions and a refusal arrives as the last line, in the machine's words, naming the switch to flip.",
        })
        .input(DeviceSandboxFlowInputSchema)
        .output(streamOf(DeviceFlowLineSchema)),
    // Closed set of actions; the daemon builds the command line, not the caller. One sentence is the whole answer.
    runDeviceCommand: systemRoute
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
    runDeviceAgentFlow: systemRoute
        .route({
            method: "POST",
            path: "/system/devices/{id}/agent/{op}",
            summary: "Update, restart, or clean up the links of the agent on one of your own devices",
            description:
                "Updates a machine you own to the current intentic-machine agent, restarts the loop it is running, or drops the links it holds to sandboxes that have stopped answering — over the connection that machine holds open. The answer is a stream of the run's own output — and it normally stops mid-run, because the agent's loop is what carries this connection: the work is detached from it first, so it finishes regardless, and the device's reported version is what confirms it. Takes the machine's \"Run commands\" permission, the same one a command typed there would.",
        })
        .input(DeviceAgentFlowInputSchema)
        .output(streamOf(DeviceFlowLineSchema)),
};
